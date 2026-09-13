import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
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
import { lookupContactNames } from './virtualNumber.helpers.js';
import type { VirtualNumberRow } from './virtualNumber.helpers.js';
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
 * Plivo-only webhook handlers — split out of virtualNumber.ts so each provider's
 * webhook surface can grow independently. Routes keep their original paths
 * (`/api/virtual-number/...`, no extra prefix) since Plivo Applications already
 * created in production point at these exact URLs.
 */

/** Creates the browser-calling Endpoint + inbound Application on first need, shared across every
 * number the workspace owns (one SIP login per workspace, however many numbers it holds), and
 * links this row's number to that Application so inbound calls ring the shared browser Endpoint
 * instead of Plivo's default handler. Idempotent — safe to call on every browser-credentials request. */
export async function ensurePlivoBrowserCalling(row: VirtualNumberRow): Promise<VirtualNumberRow> {
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
    ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: to, status: 'active', provider: 'plivo' } })
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

export default function registerPlivoWebhooks(app: FastifyInstance) {
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
      ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: toDigits, status: 'active', provider: 'plivo' } })
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
        ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: to, status: 'active', provider: 'plivo' } })
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
}
