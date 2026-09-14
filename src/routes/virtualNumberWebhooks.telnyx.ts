import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import * as telnyx from '../services/telnyx.service.js';
import {
  extraHeaderCallerId,
  normalizeE164ForDial,
  texmlDialNumber,
  texmlDialSip,
  texmlSpeak,
  sipUriForEndpoint,
  endpointUsernameFromSip,
} from '../services/telnyxXml.js';
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
 * Telnyx-only webhook handlers — the Telnyx counterpart of virtualNumberWebhooks.plivo.ts.
 * Routes live under `/telnyx/*` within the shared `/api/virtual-number` prefix (new URLs,
 * no backward-compat constraint the way Plivo's paths have).
 *
 * VERIFICATION STATUS: Telnyx's TeXML webhook field names below (`CallSid`, `To`, `From`,
 * `DialCallStatus`) follow Telnyx's documented Twilio-compatibility for TeXML. Smoke-test
 * against a live Telnyx TeXML Application before the first real call — see the plan's
 * verification section.
 */

export async function ensureTelnyxBrowserCalling(row: VirtualNumberRow): Promise<VirtualNumberRow> {
  if (!config.telnyx.enabled || !row.selectedNumber) return row;

  const sibling = await prisma.virtualNumberRequest.findFirst({
    where: { workspaceId: row.workspaceId, plivoEndpointUsername: { not: null }, id: { not: row.id }, provider: 'telnyx' },
  });

  let endpointId = row.plivoEndpointId ?? sibling?.plivoEndpointId ?? null;
  let endpointUsername = row.plivoEndpointUsername ?? sibling?.plivoEndpointUsername ?? null;
  let endpointPassword = row.plivoEndpointPassword ?? sibling?.plivoEndpointPassword ?? null;
  let appId = row.plivoAppId ?? sibling?.plivoAppId ?? null;

  if (!appId) {
    const app = await telnyx.createApplication({
      alias: `convosync_${row.workspaceId.slice(-12)}`,
      answerUrl: `${config.backendPublicUrl}/api/virtual-number/telnyx/inbound-answer-xml`,
      hangupUrl: `${config.backendPublicUrl}/api/virtual-number/telnyx/inbound-hangup-xml`,
    });
    appId = app.appId;
  }
  if (!endpointUsername) {
    const endpoint = await telnyx.createEndpoint(`workspace_${row.workspaceId.slice(-12)}`, appId);
    endpointId = endpoint.endpointId;
    endpointUsername = endpoint.username;
    endpointPassword = endpoint.password;
  }

  await telnyx.setNumberApplication(row.selectedNumber, appId);
  if (endpointId) {
    await telnyx.setEndpointApplication(endpointId, appId);
    // Must run after setEndpointApplication — see setEndpointCallerId's own comment on why
    // it merges rather than assuming PATCH order doesn't matter.
    await telnyx.setEndpointCallerId(endpointId, row.selectedNumber);
  }

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
    ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: to, status: 'active', provider: 'telnyx' } })
    : null;

  if (!row?.plivoEndpointUsername) {
    return texmlSpeak("Sorry, this number can't take calls right now.");
  }

  const callerIdDigits = from.replace(/\D/g, '');
  const callUuid = body.CallSid || null;

  try {
    const contactsByDigits = await lookupContactNames(row.workspaceId, [callerIdDigits]);
    getIo().to(row.workspaceId).emit('incoming_call', {
      callUuid,
      numberId: row.id,
      numberLabel: row.label,
      from: telnyx.formatDisplayNumber(callerIdDigits),
      contactName: contactsByDigits.get(callerIdDigits)?.name ?? null,
    });
  } catch {
    // Best-effort — the socket ping is a UI convenience, never worth failing the call over.
  }

  const dialCallbackUrl = `${config.backendPublicUrl}/api/virtual-number/telnyx/dial-callback?requestId=${encodeURIComponent(row.id)}&from=${encodeURIComponent(from)}`;
  return texmlDialSip({
    callerId: callerIdDigits,
    sipUri: sipUriForEndpoint(row.plivoEndpointUsername),
    timeoutSeconds: 25,
    actionUrl: dialCallbackUrl,
  });
}

/** Browser SDK outbound: Telnyx hits the connection's voice_url with To=dest. */
async function outboundAnswerXml(body: Record<string, string>): Promise<string> {
  const toDigits = normalizeE164ForDial(body.To || '');
  const username = endpointUsernameFromSip(body.From || '');
  if (!toDigits || !username) {
    return texmlSpeak("Sorry, this call can't be completed right now.");
  }

  const row = await prisma.virtualNumberRequest.findFirst({
    where: { plivoEndpointUsername: username, status: 'active', provider: 'telnyx' },
  });
  if (!row?.selectedNumber) {
    return texmlSpeak("Sorry, this call can't be completed right now.");
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

  const dialCallbackUrl = `${config.backendPublicUrl}/api/virtual-number/telnyx/dial-callback?requestId=${encodeURIComponent(row.id)}&from=${encodeURIComponent(toDigits)}&side=user`;
  return texmlDialNumber({ callerId, number: toDigits, actionUrl: dialCallbackUrl });
}

/** Twilio/TeXML's DialCallStatus vocabulary ('completed'/'busy'/'no-answer'/'failed'/'canceled')
 * lines up with what missedCallReply.service.ts already expects, except 'canceled' — folded
 * into 'failed' here so the shared helper doesn't need a Telnyx-specific branch. */
function normalizeDialStatus(raw: string): string {
  const s = raw.toLowerCase();
  return s === 'canceled' ? 'failed' : s;
}

export default function registerTelnyxWebhooks(app: FastifyInstance) {
  app.get('/telnyx/answer-xml', async (_request, reply) => {
    reply.header('Content-Type', 'text/xml');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, this is a test call from Convo Sync. This call is being recorded.</Say>
  <Record recordingStatusCallback="${config.backendPublicUrl}/api/virtual-number/telnyx/transcription-webhook" transcribe="true" maxLength="120" />
  <Say>Thanks, goodbye.</Say>
</Response>`;
  });

  // Telnyx posts StatusCallback/status_callback as POST (confirmed live — a GET-only
  // route here 404s and shows as a failed webhook attempt in the Telnyx dashboard,
  // even though it doesn't affect the call itself). Also answer GET for safety/manual checks.
  app.get('/telnyx/hangup-xml', async () => ({ status: 'ok' }));
  app.post('/telnyx/hangup-xml', async () => ({ status: 'ok' }));

  /** Shared voice_url for (1) inbound PSTN calls to a workspace number and (2) outbound
   * calls the browser widget places from the Credential Connection. */
  app.post('/telnyx/inbound-answer-xml', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    reply.header('Content-Type', 'text/xml');

    const toDigits = (body.To || '').replace(/\D/g, '');
    const inboundRow = toDigits
      ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: toDigits, status: 'active', provider: 'telnyx' } })
      : null;
    if (inboundRow) return inboundAnswerXml(body);
    return outboundAnswerXml(body);
  });

  app.post('/telnyx/inbound-hangup-xml', async (request) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const to = (body.To || '').replace(/\D/g, '');
    const callUuid = body.CallSid || null;

    try {
      const row = to
        ? await prisma.virtualNumberRequest.findFirst({ where: { selectedNumber: to, status: 'active', provider: 'telnyx' } })
        : null;
      if (row) {
        getIo().to(row.workspaceId).emit('incoming_call_ended', { callUuid, numberId: row.id });
      }
    } catch {
      // Best-effort.
    }

    return { status: 'ok' };
  });

  app.post('/telnyx/dial-callback', async (request, reply) => {
    const query = request.query as { requestId?: string; from?: string; side?: string };
    const body = (request.body ?? {}) as Record<string, string>;
    const dialStatus = normalizeDialStatus(body.DialCallStatus || body.DialStatus || '');
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
            const callerLabel = contactName ?? telnyx.formatDisplayNumber(callerDigits);
            void emitNotification({
              workspaceId: row.workspaceId,
              type: NOTIFICATION_TYPES.CALL_MISSED,
              title: 'Missed call',
              message: `Missed call from ${callerLabel}${row.label ? ` on ${row.label}` : ''}.`,
              entityType: 'virtual_number_request',
              entityId: row.id,
              metadata: { numberId: row.id, fromNumber: telnyx.formatDisplayNumber(callerDigits) },
            });
          }
        }
      } catch {
        // Best-effort — a failed auto-reply should never break call handling.
      }
    }

    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  });

  /** Telnyx posts the finished transcript here once <Record transcribe="true"> completes. */
  app.post('/telnyx/transcription-webhook', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const callUuid = String(body.CallSid ?? body.call_leg_id ?? '');
    const text = String(body.TranscriptionText ?? body.transcription_text ?? '');
    if (!callUuid || !text) return reply.code(200).send({ status: 'ignored' });

    await prisma.plivoCallTranscript.upsert({
      where: { callUuid },
      create: { callUuid, text },
      update: { text },
    });
    return { status: 'ok' };
  });

  /** Telnyx's Detail Record Search API has been observed to 500 persistently for this
   * account (confirmed live, independent of our code) — so the call log for Telnyx
   * numbers is built from these real-time Call Control webhooks into TelnyxCallLog
   * instead of querying that API. Configured as the Credential Connection's
   * webhook_event_url (see setEndpointCallerId's sibling call in ensureTelnyxBrowserCalling).
   * VERIFICATION STATUS: field names below are best-effort from Telnyx's documented Call
   * Control webhook envelope — not yet confirmed against a real payload from this account. */
  app.post('/telnyx/call-events', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    request.log.info({ telnyxCallEvent: body }, 'telnyx call-events webhook');

    const data = (body.data ?? body) as Record<string, unknown>;
    const eventType = String(data.event_type ?? data.EventType ?? '');
    const payload = (data.payload ?? data) as Record<string, unknown>;

    const callUuid = String(payload.call_leg_id ?? payload.call_control_id ?? payload.CallLegId ?? '');
    if (!callUuid || !eventType.startsWith('call.')) return reply.code(200).send({ status: 'ignored' });

    const fromDigits = String(payload.from ?? payload.From ?? '').replace(/\D/g, '');
    const toDigits = String(payload.to ?? payload.To ?? '').replace(/\D/g, '');
    const direction = String(payload.direction ?? payload.Direction ?? '').toLowerCase().includes('inbound')
      ? 'inbound'
      : 'outbound';

    const row = fromDigits || toDigits
      ? await prisma.virtualNumberRequest.findFirst({
          where: {
            status: 'active',
            provider: 'telnyx',
            OR: [{ selectedNumber: fromDigits }, { selectedNumber: toDigits }],
          },
        })
      : null;
    if (!row) return reply.code(200).send({ status: 'ignored', reason: 'no matching workspace number' });

    const callState = eventType.replace('call.', '');
    const now = new Date();
    const existing = await prisma.telnyxCallLog.findUnique({
      where: { callUuid },
      select: { startTime: true, callState: true },
    });
    // Don't let call.hangup's own event name ("hangup") clobber a prior call.answered —
    // statusFromCallRecord (shared with Plivo) reads callState==='answered' to show the
    // row as Answered rather than Missed/Failed, so the hangup update must preserve that.
    const nextCallState = eventType === 'call.hangup' && existing?.callState === 'answered' ? 'answered' : callState;

    await prisma.telnyxCallLog.upsert({
      where: { callUuid },
      create: {
        callUuid,
        workspaceId: row.workspaceId,
        fromNumber: fromDigits,
        toNumber: toDigits,
        direction,
        callState,
        startTime: now,
      },
      update: {
        callState: nextCallState,
        ...(eventType === 'call.hangup'
          ? {
              endTime: now,
              hangupCause: (payload.hangup_cause ?? payload.HangupCause) as string | undefined,
              durationSeconds: existing?.startTime
                ? Math.max(0, Math.round((now.getTime() - existing.startTime.getTime()) / 1000))
                : 0,
            }
          : {}),
        ...(eventType === 'call.recording.saved'
          ? {
              recordUrl:
                ((payload.recording_urls as { mp3?: string }[] | undefined)?.[0]?.mp3 as string | undefined) ??
                (payload.public_recording_urls as { mp3?: string } | undefined)?.mp3 ??
                null,
            }
          : {}),
      },
    });

    return { status: 'ok' };
  });
}
