import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  availableNumbersQuerySchema,
  callLogQuerySchema,
  numberSettingsBodySchema,
  payVerifyBodySchema,
  placeCallBodySchema,
  requestAccessBodySchema,
  selectNumberBodySchema,
} from './virtualNumber.schemas.js';
import { companyAuth, companyAuthBilling } from '../middleware/workspaceScope.js';
import { getJwtUser } from '../middleware/auth.js';
import { config } from '../config.js';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import { verifyRazorpayPaymentSignature } from '../utils/crypto.utils.js';
import * as plivo from '../services/plivo.service.js';
import {
  extraHeaderCallerId,
  normalizeIndiaPstn,
  plivoXmlDialNumber,
  plivoXmlDialUser,
  plivoXmlSpeak,
  sipUriForEndpoint,
  endpointUsernameFromSip,
} from '../services/plivoXml.js';
import { whatsappCanonicalDigits } from '../lib/whatsappContact.js';
import {
  missedCallReplyConfig,
  sendMissedCallWhatsApp,
  shouldSendUserMissReply,
  wasDialAnswered,
} from '../services/missedCallReply.service.js';
import { emitNotification } from '../services/notifications/emitNotification.js';
import { NOTIFICATION_TYPES } from '../services/notifications/types.js';
import { getIo } from '../socket.js';

/**
 * Virtual Number (Plivo) request → admin approval → pick a number → pay → activate.
 * Admin approval lives in the super-admin app (routes/platform/virtual-number-requests.ts).
 * The actual Plivo purchase only happens after a verified Razorpay payment (real money).
 *
 * A workspace can hold several numbers at once. `GET /` tracks the single latest
 * request — it drives the acquire-a-number wizard (pending/select/pay/active) and stays
 * a single row on purpose, since only one purchase is ever in flight at a time. Once a
 * request reaches `active`, it also shows up in `GET /numbers`, the list of every number
 * the workspace actually owns — that's what Calls, Settings, and browser calling use.
 */

const TERMINAL_OR_ACTIVE = new Set(['rejected', 'active']);

/** Flat per-type base pricing (pre-tax) — kept on our side rather than trusting
 * Plivo's returned rental rate, which is not guaranteed to be in INR. */
function priceForType(type: string): number {
  return type === 'tollfree' || type === 'toll_free' ? 750_00 : 300_00;
}

const GST_RATE = 0.18;

/** Base price → amount actually charged (base + 18% GST), rounded to the paisa. */
function withGst(baseInrPaise: number): number {
  return Math.round(baseInrPaise * (1 + GST_RATE));
}

/** Same fallback USD→INR rate used elsewhere for display-only conversions (workspaceTokenUsage.ts). */
const USD_TO_INR = 85;
const CALL_MARKUP_RATE = 0.1;

function outboundPerMinInrPaise(usdPerMin: number): number {
  const usd = Number.isFinite(usdPerMin) && usdPerMin > 0 ? usdPerMin : 0;
  return Math.round(Math.round(usd * USD_TO_INR * 100) * (1 + CALL_MARKUP_RATE));
}

/** Answered / no-answer / busy / failed, derived from Plivo's call_state + hangup cause. */
function statusFromPlivoCall(record: plivo.PlivoCallRecord): 'answered' | 'no-answer' | 'busy' | 'failed' {
  if (record.callState === 'ANSWER') return 'answered';
  const cause = (record.hangupCause ?? '').toLowerCase();
  if (cause.includes('busy')) return 'busy';
  if (cause.includes('no answer') || cause.includes('unanswered')) return 'no-answer';
  return 'failed';
}

function otherPartyDigits(record: plivo.PlivoCallRecord, ourNumber: string): string {
  const ourDigits = ourNumber.replace(/\D/g, '');
  const otherParty = record.from.replace(/\D/g, '').includes(ourDigits) ? record.to : record.from;
  return otherParty.replace(/\D/g, '');
}

type ContactRef = { id: string; name: string };

function toCallLogEntry(
  record: plivo.PlivoCallRecord,
  ourNumber: string,
  hasRecording: boolean,
  contact: ContactRef | null = null
) {
  const ourDigits = ourNumber.replace(/\D/g, '');
  const otherParty = record.from.replace(/\D/g, '').includes(ourDigits) ? record.to : record.from;
  return {
    id: record.callUuid,
    direction: record.direction,
    status: statusFromPlivoCall(record),
    contact: {
      phone: plivo.formatDisplayNumber(otherParty),
      name: contact?.name ?? null,
      contactId: contact?.id ?? null,
    },
    fromNumber: plivo.formatDisplayNumber(ourNumber),
    startedAt: record.startTime,
    durationSeconds: record.durationSeconds,
    hasRecording,
  };
}

/** Matches raw call-log numbers against the workspace's contact book (same +91/local
 * collapse rules as WhatsApp contact dedupe) so calls from a known contact show their
 * name (and link to their contact page) instead of just the bare number. Returns a map
 * keyed by the raw digits passed in. */
async function lookupContactNames(
  workspaceId: string,
  rawDigitsList: string[]
): Promise<Map<string, ContactRef>> {
  const canonicalByRaw = new Map<string, string>();
  const canonicalSet = new Set<string>();
  for (const digits of rawDigitsList) {
    const canonical = whatsappCanonicalDigits(digits);
    if (!canonical) continue;
    canonicalByRaw.set(digits, canonical);
    canonicalSet.add(canonical);
  }
  if (canonicalSet.size === 0) return new Map();

  const orClauses = Array.from(canonicalSet).flatMap((c) => [
    { phone: c },
    { phone: `+${c}` },
    { phone: `91${c}` },
    { phone: `+91${c}` },
  ]);

  const contacts = await prisma.contact.findMany({
    where: { workspaceId, OR: orClauses },
    select: { id: true, name: true, phone: true },
  });

  const byCanonical = new Map<string, ContactRef>();
  for (const c of contacts) {
    const key = whatsappCanonicalDigits(c.phone);
    if (key && !byCanonical.has(key)) byCanonical.set(key, { id: c.id, name: c.name });
  }

  const result = new Map<string, ContactRef>();
  for (const [raw, canonical] of canonicalByRaw) {
    const ref = byCanonical.get(canonical);
    if (ref) result.set(raw, ref);
  }
  return result;
}

function findLatest(workspaceId: string) {
  return prisma.virtualNumberRequest.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
}

type VirtualNumberRow = NonNullable<Awaited<ReturnType<typeof findLatest>>>;

function serialize(row: VirtualNumberRow) {
  return {
    id: row.id,
    stage: row.status,
    label: row.label,
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    selectedNumber: row.selectedNumber
      ? {
          // Raw Plivo digits — the frontend matches this against the search
          // results' `.number` field to highlight the selected card.
          number: row.selectedNumber,
          city: row.selectedCity,
          priceInrPaise: row.selectedPriceInrPaise,
        }
      : null,
    razorpayOrderId: row.razorpayOrderId,
    paidAt: row.paidAt?.toISOString() ?? null,
    activeNumber:
      row.status === 'active' && row.selectedNumber
        ? {
            number: plivo.formatDisplayNumber(row.selectedNumber),
            city: row.selectedCity,
            plivoNumberId: row.plivoNumberId,
          }
        : null,
    purchaseError: row.purchaseError,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    missedCallAutoReplyEnabled: row.missedCallAutoReplyEnabled,
    missedCallMessage: row.missedCallMessage,
    missedCallTemplateId: row.missedCallTemplateId,
    userMissedCallAutoReplyEnabled: row.userMissedCallAutoReplyEnabled,
    userMissedCallMessage: row.userMissedCallMessage,
    userMissedCallTemplateId: row.userMissedCallTemplateId,
  };
}

/** One entry in the workspace's number list — every `active` row, each independently manageable. */
function serializeNumber(row: VirtualNumberRow) {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    number: row.selectedNumber ? plivo.formatDisplayNumber(row.selectedNumber) : null,
    rawNumber: row.selectedNumber,
    city: row.selectedCity,
    plivoNumberId: row.plivoNumberId,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    missedCallAutoReplyEnabled: row.missedCallAutoReplyEnabled,
    missedCallMessage: row.missedCallMessage,
    missedCallTemplateId: row.missedCallTemplateId,
    userMissedCallAutoReplyEnabled: row.userMissedCallAutoReplyEnabled,
    userMissedCallMessage: row.userMissedCallMessage,
    userMissedCallTemplateId: row.userMissedCallTemplateId,
  };
}

function findActiveNumbers(workspaceId: string) {
  return prisma.virtualNumberRequest.findMany({
    where: { workspaceId, status: 'active' },
    orderBy: { activatedAt: 'asc' },
  });
}

function findActiveById(workspaceId: string, id: string) {
  return prisma.virtualNumberRequest.findFirst({ where: { id, workspaceId, status: 'active' } });
}

/** Creates the browser-calling Endpoint + inbound Application on first need, shared across every
 * number the workspace owns (one SIP login per workspace, however many numbers it holds), and
 * links this row's number to that Application so inbound calls ring the shared browser Endpoint
 * instead of Plivo's default handler. Idempotent — safe to call on every browser-credentials request. */
async function ensureBrowserCalling(row: VirtualNumberRow): Promise<VirtualNumberRow> {
  if (!config.plivo.enabled || !row.selectedNumber) return row;

  // Reuse an existing shared Endpoint/Application from any other number in this workspace
  // before creating new ones, so the browser only ever needs a single SIP login.
  const sibling = await prisma.virtualNumberRequest.findFirst({
    where: { workspaceId: row.workspaceId, plivoEndpointUsername: { not: null }, id: { not: row.id } },
  });

  let endpointId = row.plivoEndpointId ?? sibling?.plivoEndpointId ?? null;
  let endpointUsername = row.plivoEndpointUsername ?? sibling?.plivoEndpointUsername ?? null;
  let endpointPassword = row.plivoEndpointPassword ?? sibling?.plivoEndpointPassword ?? null;
  let appId = row.plivoAppId ?? sibling?.plivoAppId ?? null;

  // Application first so a fresh Endpoint can be created already attached to it.
  // Outbound Browser SDK calls fetch THIS application's answer_url — without that
  // link Plivo has no XML and the SDK reports Busy.
  if (!appId) {
    const app = await plivo.createApplication({
      alias: `convosync_${row.workspaceId.slice(-12)}`,
      answerUrl: `${config.backendPublicUrl}/api/virtual-number/inbound-answer-xml`,
      hangupUrl: `${config.backendPublicUrl}/api/virtual-number/inbound-hangup-xml`,
    });
    appId = app.appId;
  }
  if (!endpointUsername) {
    const endpoint = await plivo.createEndpoint(`workspace_${row.workspaceId.slice(-12)}`, appId);
    endpointId = endpoint.endpointId;
    endpointUsername = endpoint.username;
    endpointPassword = endpoint.password;
  }

  await plivo.setNumberApplication(row.selectedNumber, appId);
  if (endpointId) await plivo.setEndpointApplication(endpointId, appId);

  if (
    row.plivoEndpointId === endpointId &&
    row.plivoEndpointUsername === endpointUsername &&
    row.plivoEndpointPassword === endpointPassword &&
    row.plivoAppId === appId
  ) {
    return row;
  }

  return prisma.virtualNumberRequest.update({
    where: { id: row.id },
    data: {
      plivoEndpointId: endpointId,
      plivoEndpointUsername: endpointUsername,
      plivoEndpointPassword: endpointPassword,
      plivoAppId: appId,
    },
  });
}

async function inboundAnswerXml(body: Record<string, string>): Promise<string> {
  const to = (body.To || '').replace(/\D/g, '');
  const from = body.From || '';

  const row = to
    ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: to, status: 'active' } })
    : null;

  if (!row?.plivoEndpointUsername) {
    return plivoXmlSpeak("Sorry, this number can't take calls right now.");
  }

  // callerId is who the agent's browser sees as calling them — the actual caller, not our own number.
  const callerIdDigits = from.replace(/\D/g, '');
  const callUuid = body.CallUUID || null;

  try {
    const contactsByDigits = await lookupContactNames(row.workspaceId, [callerIdDigits]);
    getIo().to(row.workspaceId).emit('incoming_call', {
      callUuid,
      numberId: row.id,
      numberLabel: row.label,
      from: plivo.formatDisplayNumber(callerIdDigits),
      contactName: contactsByDigits.get(callerIdDigits)?.name ?? null,
    });
  } catch {
    // Best-effort — the socket ping is a UI convenience, never worth failing the call over.
  }

  const dialCallbackUrl = `${config.backendPublicUrl}/api/virtual-number/dial-callback?requestId=${encodeURIComponent(row.id)}&from=${encodeURIComponent(from)}`;
  return plivoXmlDialUser({
    callerId: callerIdDigits,
    sipUri: sipUriForEndpoint(row.plivoEndpointUsername),
    timeoutSeconds: 25,
    actionUrl: dialCallbackUrl,
  });
}

/** Browser SDK outbound: Plivo hits the Endpoint's Application answer_url with To=dest.
 * Return `<Dial><Number>` so the PSTN leg actually rings. */
async function outboundAnswerXml(body: Record<string, string>): Promise<string> {
  const toDigits = normalizeIndiaPstn(body.To || '');
  const username = endpointUsernameFromSip(body.From || '');
  if (!toDigits || !username) {
    return plivoXmlSpeak("Sorry, this call can't be completed right now.");
  }

  const row = await prisma.virtualNumberRequest.findFirst({
    where: { plivoEndpointUsername: username, status: 'active' },
  });
  if (!row?.selectedNumber) {
    return plivoXmlSpeak("Sorry, this call can't be completed right now.");
  }

  const workspaceNumbers = await prisma.virtualNumberRequest.findMany({
    where: { workspaceId: row.workspaceId, status: 'active' },
    select: { selectedNumber: true },
  });
  const owned = new Set(
    workspaceNumbers.map((n) => n.selectedNumber?.replace(/\D/g, '')).filter((d): d is string => Boolean(d)),
  );
  const headerCallerId = extraHeaderCallerId(body);
  const callerId = (headerCallerId && owned.has(headerCallerId) ? headerCallerId : null) ?? row.selectedNumber;

  const dialCallbackUrl = `${config.backendPublicUrl}/api/virtual-number/dial-callback?requestId=${encodeURIComponent(row.id)}&from=${encodeURIComponent(toDigits)}&side=user`;
  return plivoXmlDialNumber({ callerId, number: toDigits, actionUrl: dialCallbackUrl });
}

export default async function virtualNumberRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const razorpay = new RazorpayService(fastify);

  app.get('/', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest) return { stage: 'not_requested' };
    return serialize(latest);
  });

  /** Every number this workspace actually owns — used by Calls, Settings, and browser calling. */
  app.get('/numbers', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const numbers = await findActiveNumbers(workspaceId);
    return { numbers: numbers.map(serializeNumber) };
  });

  /** This contact's calls across every number the workspace owns — for the Contact detail page. */
  app.get('/calls/for-contact/:contactId', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { contactId } = request.params as { contactId: string };
    const contact = await prisma.contact.findFirst({ where: { id: contactId, workspaceId } });
    if (!contact) return reply.code(404).send({ error: 'Contact not found' });
    if (!config.plivo.enabled) return { source: 'mock', entries: [] };

    const canonical = whatsappCanonicalDigits(contact.phone);
    const numbers = await findActiveNumbers(workspaceId);
    const numbersWithSelection = numbers.filter(
      (row): row is VirtualNumberRow & { selectedNumber: string } => Boolean(row.selectedNumber)
    );
    if (!canonical || numbersWithSelection.length === 0) return { source: 'plivo', entries: [] };

    try {
      const recordedUuids = await plivo.listRecordedCallUuids(30);
      const perNumber = await Promise.all(
        numbersWithSelection.map(async (row) => {
          try {
            const { records } = await plivo.listCalls({ number: row.selectedNumber, limit: 30 });
            return records
              .filter((r) => whatsappCanonicalDigits(otherPartyDigits(r, row.selectedNumber)) === canonical)
              .map((r) => ({
                ...toCallLogEntry(r, row.selectedNumber, recordedUuids.has(r.callUuid), {
                  id: contact.id,
                  name: contact.name,
                }),
                numberId: row.id,
                numberLabel: row.label,
              }));
          } catch {
            return [];
          }
        })
      );

      const entries = perNumber
        .flat()
        .sort((a, b) => (b.startedAt ? Date.parse(b.startedAt) : 0) - (a.startedAt ? Date.parse(a.startedAt) : 0))
        .slice(0, 20);

      return { source: 'plivo', entries };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Plivo call log fetch failed' });
    }
  });

  app.get(
    '/:id/call-log',
    { onRequest: companyAuth.onRequest, schema: { querystring: callLogQuerySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const query = request.query;
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }
    if (!config.plivo.enabled) {
      return { source: 'mock', entries: [], nextCursor: null };
    }

    try {
      const [{ records, hasMore }, recordedUuids] = await Promise.all([
        plivo.listCalls({ number: row.selectedNumber, limit: query.limit, offset: query.cursor }),
        plivo.listRecordedCallUuids(30),
      ]);
      const digitsByRecord = records.map((r) => otherPartyDigits(r, row.selectedNumber!));
      const contactsByDigits = await lookupContactNames(workspaceId, digitsByRecord);
      return {
        source: 'plivo',
        entries: records.map((r, i) =>
          toCallLogEntry(
            r,
            row.selectedNumber!,
            recordedUuids.has(r.callUuid),
            contactsByDigits.get(digitsByRecord[i]) ?? null
          )
        ),
        nextCursor: hasMore ? query.cursor + query.limit : null,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Plivo call log fetch failed' });
    }
  });

  app.get('/:id/call-log/:callUuid', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id, callUuid } = request.params as { id: string; callUuid: string };
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }

    try {
      const [detail, transcript] = await Promise.all([
        plivo.getCallDetail(callUuid),
        prisma.plivoCallTranscript.findUnique({ where: { callUuid } }),
      ]);
      const otherDigits = otherPartyDigits(detail, row.selectedNumber);
      const namesByDigits = await lookupContactNames(workspaceId, [otherDigits]);
      const entry = toCallLogEntry(
        detail,
        row.selectedNumber,
        Boolean(detail.recordUrl),
        namesByDigits.get(otherDigits) ?? null
      );
      return {
        ...entry,
        recordUrl: detail.recordUrl,
        hangupCause: detail.hangupCause,
        transcript: transcript?.text ?? null,
        callUuid: detail.callUuid,
        answerTime: detail.answerTime,
        ringDurationSeconds: detail.ringDurationSeconds,
        postDialDelaySeconds: detail.postDialDelaySeconds,
        hangupCauseCode: detail.hangupCauseCode,
        hangupSource: detail.hangupSource,
        stirVerification: detail.stirVerification,
        sourceIp: detail.sourceIp,
        // Plivo reports cost in USD — convert so it matches every other price shown in the app (₹).
        totalCostInrPaise: detail.totalAmount ? Math.round(parseFloat(detail.totalAmount) * USD_TO_INR * 100) : null,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not load this call.' });
    }
  });

  /** Placing a call spends real per-minute money on the connected Plivo account. */
  app.post(
    '/:id/call',
    { onRequest: companyAuth.onRequest, schema: { body: placeCallBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }
    if (!config.plivo.enabled) {
      return reply.code(409).send({ error: 'Plivo is not configured on this server.' });
    }

    const toDigits = request.body.to.replace(/\D/g, '');

    try {
      const result = await plivo.makeCall({
        from: row.selectedNumber,
        to: toDigits,
        answerUrl: `${config.backendPublicUrl}/api/virtual-number/answer-xml`,
        hangupUrl: `${config.backendPublicUrl}/api/virtual-number/hangup-xml`,
      });
      return { requestUuid: result.requestUuid, message: result.message };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not place the call.' });
    }
  });

  // --- Plivo webhooks: no auth — Plivo's own servers call these directly. ---

  app.get('/answer-xml', async (_request, reply) => {
    const transcriptionUrl = `${config.backendPublicUrl}/api/virtual-number/transcription-webhook`;
    reply.header('Content-Type', 'text/xml');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>Hello, this is a test call from Convo Sync. This call is being recorded.</Speak>
  <Record redirect="false" recordSession="true" transcriptionType="auto" transcriptionUrl="${transcriptionUrl}" maxLength="120" />
  <Speak>Thanks, goodbye.</Speak>
</Response>`;
  });

  app.get('/hangup-xml', async () => ({ status: 'ok' }));

  /** Shared Answer URL for (1) inbound PSTN calls to a workspace number and (2) outbound
   * calls the Browser SDK places from the Endpoint. Same Application is linked to both
   * the Number and the Endpoint; Direction/From tell us which XML to return.
   * Dial children must be `<User>` (SIP) or `<Number>` (PSTN) — never `<Client>`. */
  app.post('/inbound-answer-xml', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    reply.header('Content-Type', 'text/xml');

    // Browser SDK outbound still arrives with Direction=inbound (Plivo fetches the
    // Endpoint app as if the INVITE were an inbound call to us). Distinguish by To:
    // PSTN inbound To = our virtual number; browser outbound To = the dest.
    const toDigits = (body.To || '').replace(/\D/g, '');
    const inboundRow = toDigits
      ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: toDigits, status: 'active' } })
      : null;
    if (inboundRow) return inboundAnswerXml(body);
    return outboundAnswerXml(body);
  });

  /** Fires once the inbound call's leg actually ends (answered-and-hung-up, or the
   * caller gave up) — tells the frontend to drop the "incoming call" screen it showed
   * from the /inbound-answer-xml ping, independent of whether the browser's own
   * WebRTC session ever picked it up. */
  app.post('/inbound-hangup-xml', async (request) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const to = (body.To || '').replace(/\D/g, '');
    const callUuid = body.CallUUID || null;

    try {
      const row = to
        ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: to, status: 'active' } })
        : null;
      if (row) {
        getIo().to(row.workspaceId).emit('incoming_call_ended', { callUuid, numberId: row.id });
      }
    } catch {
      // Best-effort.
    }

    return { status: 'ok' };
  });

  /** Fires once a <Dial> finishes. Platform miss = inbound, agent never answered.
   * User miss = outbound, callee never answered. Same send helper either way. */
  app.post('/dial-callback', async (request, reply) => {
    const query = request.query as { requestId?: string; from?: string; side?: string };
    const body = (request.body ?? {}) as Record<string, string>;
    const dialStatus = (body.DialStatus || body.DialCallStatus || body.DialBLegStatus || '').toLowerCase();
    const side = query.side === 'user' ? 'user' : 'platform';
    reply.header('Content-Type', 'text/xml');

    const shouldReply =
      Boolean(query.requestId && query.from) &&
      (side === 'user' ? shouldSendUserMissReply(dialStatus) : !wasDialAnswered(dialStatus));

    if (shouldReply) {
      try {
        const row = await prisma.virtualNumberRequest.findFirst({
          where: { id: query.requestId, status: 'active' },
        });
        if (row) {
          const replyCfg = missedCallReplyConfig(row, side);
          const callerDigits = query.from!.replace(/\D/g, '');
          const contactsByDigits = await lookupContactNames(row.workspaceId, [callerDigits]);
          const contactName = contactsByDigits.get(callerDigits)?.name ?? null;

          if (replyCfg.enabled && (replyCfg.templateId || replyCfg.message)) {
            await sendMissedCallWhatsApp({
              workspaceId: row.workspaceId,
              toPhone: query.from!,
              message: replyCfg.message,
              templateId: replyCfg.templateId,
              contactName,
            });
          }

          if (side === 'platform') {
            const callerLabel = contactName ?? plivo.formatDisplayNumber(callerDigits);
            void emitNotification({
              workspaceId: row.workspaceId,
              type: NOTIFICATION_TYPES.CALL_MISSED,
              title: 'Missed call',
              message: `Missed call from ${callerLabel}${row.label ? ` on ${row.label}` : ''}.`,
              entityType: 'virtual_number_request',
              entityId: row.id,
              metadata: { numberId: row.id, fromNumber: plivo.formatDisplayNumber(callerDigits) },
            });
          }
        }
      } catch {
        // Best-effort — a failed auto-reply should never break call handling.
      }
    }

    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  });

  /** Credentials for the workspace's browser (Plivo Browser SDK) to log in with — one shared
   * identity for the whole workspace, however many numbers it owns. Creates it on first use. */
  app.get('/browser-credentials', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
    if (!config.plivo.enabled) {
      return reply.code(409).send({ error: 'Plivo is not configured on this server.' });
    }

    const numbers = await findActiveNumbers(workspaceId);
    if (numbers.length === 0) {
      return reply.code(409).send({ error: 'No active virtual number for this workspace.' });
    }

    try {
      const seed = numbers.find((n) => n.plivoEndpointUsername) ?? numbers[0];
      const withCreds = await ensureBrowserCalling(seed);
      if (!withCreds.plivoEndpointUsername || !withCreds.plivoEndpointPassword) {
        return reply.code(502).send({ error: 'Could not set up browser calling for this workspace.' });
      }
      // Any numbers still missing inbound routing (e.g. added before browser calling existed)
      // get linked to the now-shared Endpoint/Application too.
      await Promise.all(
        numbers.filter((n) => n.id !== seed.id && !n.plivoEndpointUsername).map((n) => ensureBrowserCalling(n).catch(() => {})),
      );
      return { username: withCreds.plivoEndpointUsername, password: withCreds.plivoEndpointPassword };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not set up browser calling.' });
    }
  });

  /** Plivo posts the finished transcript here once <Record transcriptionType="auto"> completes. */
  app.post('/transcription-webhook', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const callUuid = String(body.CallUUID ?? body.call_uuid ?? '');
    const text = String(body.TranscriptionText ?? body.transcription_text ?? '');
    if (!callUuid || !text) return reply.code(200).send({ status: 'ignored' });

    await prisma.plivoCallTranscript.upsert({
      where: { callUuid },
      create: { callUuid, text },
      update: { text },
    });
    return { status: 'ok' };
  });

  /** Kicks off getting a number — always starts a fresh request, so a workspace that
   * already has active numbers can request another one alongside them. */
  app.post(
    '/request-access',
    { onRequest: companyAuth.onRequest, schema: { body: requestAccessBodySchema } },
    async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = request.body;

    const latest = await findLatest(workspaceId);
    // Idempotent: an in-flight (not yet active/rejected) request already covers this — just report it.
    if (latest && !TERMINAL_OR_ACTIVE.has(latest.status)) {
      return serialize(latest);
    }

    const created = await prisma.virtualNumberRequest.create({
      data: {
        workspaceId,
        requestedByUserId: userId ?? null,
        status: 'pending_approval',
        label: body.label || null,
        description: body.description || null,
      },
    });
    return serialize(created);
  });

  app.get(
    '/available-numbers',
    { onRequest: companyAuth.onRequest, schema: { querystring: availableNumbersQuerySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest || !['approved', 'number_selected', 'paid'].includes(latest.status)) {
      return reply.code(409).send({ error: 'Request has not been approved yet.' });
    }

    const query = request.query;

    if (!config.plivo.enabled) {
      // Dev fallback so the flow is walkable without real Plivo credentials.
      const all = [
        { number: '912264231648', displayNumber: '+91 22 6423 1648', city: 'Mumbai', type: 'fixed', priceInrPaise: priceForType('fixed') },
        { number: '912264231645', displayNumber: '+91 22 6423 1645', city: 'Mumbai', type: 'fixed', priceInrPaise: priceForType('fixed') },
        { number: '918047182032', displayNumber: '+91 80 4718 2032', city: 'Bengaluru', type: 'fixed', priceInrPaise: priceForType('fixed') },
      ];
      return { source: 'mock', numbers: all, totalCount: all.length, hasMore: false };
    }

    try {
      const results = await plivo.searchAvailableNumbers({
        pattern: query.pattern,
        offset: query.offset,
        limit: query.limit,
      });
      return {
        source: 'plivo',
        numbers: results.numbers.map((n) => ({
          number: n.number,
          displayNumber: n.displayNumber,
          city: n.city ?? n.region,
          type: n.type,
          priceInrPaise: priceForType(n.type),
        })),
        totalCount: results.totalCount,
        hasMore: results.hasMore,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Plivo search failed' });
    }
  });

  app.post(
    '/select-number',
    { onRequest: companyAuth.onRequest, schema: { body: selectNumberBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = request.body;

    const latest = await findLatest(workspaceId);
    if (!latest || !['approved', 'number_selected'].includes(latest.status)) {
      return reply.code(409).send({ error: 'Request is not ready for number selection.' });
    }

    const updated = await prisma.virtualNumberRequest.update({
      where: { id: latest.id },
      data: {
        status: 'number_selected',
        selectedNumber: body.number,
        selectedCity: body.city ?? null,
        selectedCountryIso: body.countryIso ?? null,
        selectedPriceInrPaise: body.priceInrPaise,
      },
    });
    return serialize(updated);
  });

  app.post('/pay/create-order', { onRequest: companyAuthBilling.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest || latest.status !== 'number_selected' || !latest.selectedPriceInrPaise) {
      return reply.code(409).send({ error: 'Select a number before paying.' });
    }

    try {
      const totalInrPaise = withGst(latest.selectedPriceInrPaise);
      const order = await razorpay.createOrder({
        amountPaise: totalInrPaise,
        currency: 'INR',
        receipt: `vnum_${workspaceId.slice(-8)}_${Date.now()}`,
        notes: { workspaceId, virtualNumberRequestId: latest.id, purpose: 'virtual_number_purchase' },
      });

      await prisma.virtualNumberRequest.update({
        where: { id: latest.id },
        data: { razorpayOrderId: order.id },
      });

      return {
        orderId: order.id,
        amountPaise: totalInrPaise,
        baseAmountPaise: latest.selectedPriceInrPaise,
        gstPaise: totalInrPaise - latest.selectedPriceInrPaise,
        currency: 'INR',
        keyId: razorpay.keyId,
      };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Could not start payment.' });
    }
  });

  app.post(
    '/pay/verify',
    { onRequest: companyAuthBilling.onRequest, schema: { body: payVerifyBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = request.body;

    const latest = await findLatest(workspaceId);
    if (!latest || latest.razorpayOrderId !== body.razorpay_order_id) {
      return reply.code(404).send({ error: 'No matching order for this workspace.' });
    }
    if (latest.status === 'active') return serialize(latest); // already settled — idempotent

    const validSignature = verifyRazorpayPaymentSignature(
      body.razorpay_order_id,
      body.razorpay_payment_id,
      body.razorpay_signature,
      config.razorpay.keySecret
    );
    if (!validSignature) return reply.code(400).send({ error: 'Invalid payment signature.' });

    const paid = await prisma.virtualNumberRequest.update({
      where: { id: latest.id },
      data: { status: 'paid', razorpayPaymentId: body.razorpay_payment_id, paidAt: new Date() },
    });

    if (!paid.selectedNumber) {
      return reply.code(500).send({ error: 'Payment recorded but no number was selected.' });
    }

    // Real money already moved — the Plivo purchase happens after, and failures
    // here are recoverable (purchaseError is surfaced so support can retry).
    try {
      const bought = config.plivo.enabled
        ? await plivo.buyNumber(paid.selectedNumber, `workspace:${workspaceId}`)
        : { plivoNumberId: `mock_${paid.selectedNumber}` };

      const active = await prisma.virtualNumberRequest.update({
        where: { id: paid.id },
        data: {
          status: 'active',
          plivoNumberId: bought.plivoNumberId,
          activatedAt: new Date(),
          purchaseError: null,
        },
      });

      // Browser calling (Endpoint + inbound routing) — best-effort, doesn't block activation.
      // The /browser-credentials route retries this lazily if it fails here.
      try {
        await ensureBrowserCalling(active);
      } catch {
        // ignored — number is active either way; browser calling can be provisioned later
      }

      return serialize(active);
    } catch (err) {
      const failed = await prisma.virtualNumberRequest.update({
        where: { id: paid.id },
        data: { purchaseError: err instanceof Error ? err.message : 'Plivo purchase failed' },
      });
      return reply.code(502).send({ ...serialize(failed), error: failed.purchaseError });
    }
  });

  /** Real Plivo per-minute call cost for this number, with our 10% markup applied. */
  app.get('/:id/pricing', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }

    if (!config.plivo.enabled) {
      return {
        countryIso: 'IN',
        countryName: 'India',
        outboundPerMinInrPaise: outboundPerMinInrPaise(0.0046),
        markupRate: CALL_MARKUP_RATE,
        source: 'mock',
      };
    }

    try {
      const pricing = await plivo.getVoicePricing((row.selectedCountryIso as plivo.PlivoCountryIso) ?? 'IN');
      return {
        countryIso: pricing.countryIso,
        countryName: pricing.countryName,
        outboundPerMinInrPaise: outboundPerMinInrPaise(pricing.outboundRatePerMinUsd),
        markupRate: CALL_MARKUP_RATE,
        source: 'plivo',
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not fetch call pricing.' });
    }
  });

  /** Updates a number's display name, description, and/or missed-call auto-reply configuration. */
  app.patch(
    '/:id/settings',
    { onRequest: companyAuth.onRequest, schema: { body: numberSettingsBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const row = await findActiveById(workspaceId, id);
    if (!row) return reply.code(404).send({ error: 'No such active number for this workspace.' });

    const body = request.body;

    const updated = await prisma.virtualNumberRequest.update({
      where: { id: row.id },
      data: {
        ...(body.label !== undefined && { label: body.label || null }),
        ...(body.description !== undefined && { description: body.description || null }),
        ...(body.missedCallAutoReplyEnabled !== undefined && {
          missedCallAutoReplyEnabled: body.missedCallAutoReplyEnabled,
        }),
        ...(body.missedCallMessage !== undefined && { missedCallMessage: body.missedCallMessage || null }),
        ...(body.missedCallTemplateId !== undefined && { missedCallTemplateId: body.missedCallTemplateId || null }),
        ...(body.userMissedCallAutoReplyEnabled !== undefined && {
          userMissedCallAutoReplyEnabled: body.userMissedCallAutoReplyEnabled,
        }),
        ...(body.userMissedCallMessage !== undefined && {
          userMissedCallMessage: body.userMissedCallMessage || null,
        }),
        ...(body.userMissedCallTemplateId !== undefined && {
          userMissedCallTemplateId: body.userMissedCallTemplateId || null,
        }),
      },
    });
    return serialize(updated);
  });

  /** Permanently releases this number back to Plivo — irreversible, stops billing. */
  app.post('/:id/release', { onRequest: companyAuthBilling.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }

    try {
      if (config.plivo.enabled) {
        await plivo.releaseNumber(row.selectedNumber);
        // Only tear down the shared Endpoint/Application if no other number still uses them.
        const stillShared = await prisma.virtualNumberRequest.findFirst({
          where: { workspaceId, status: 'active', id: { not: row.id }, plivoEndpointId: row.plivoEndpointId },
        });
        if (!stillShared) {
          if (row.plivoEndpointId) await plivo.deleteEndpoint(row.plivoEndpointId).catch(() => {});
          if (row.plivoAppId) await plivo.deleteApplication(row.plivoAppId).catch(() => {});
        }
      }
      const released = await prisma.virtualNumberRequest.update({
        where: { id: row.id },
        data: { status: 'released', releasedAt: new Date() },
      });
      return serialize(released);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not release this number.' });
    }
  });
}
