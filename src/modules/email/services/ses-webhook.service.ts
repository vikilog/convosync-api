import MessageValidator from 'sns-validator';
import {
  extractSesEventDetail,
  extractSesMessageId,
  mapSesEventToStatus,
  parseSesEventFromSnsMessage,
  sesEventType,
  type SnsEnvelope,
} from '../utils/ses-event-parser.js';
import { applyEmailLogProviderEvent } from './email-log-events.service.js';
import { markContactBlocked, markContactUnsubscribed } from '../../../services/contactOptOut.service.js';

export type SesWebhookResult =
  | { ok: true; kind: 'subscription_confirmed' }
  | { ok: true; kind: 'notification'; updated: boolean; eventType?: string }
  | { ok: true; kind: 'ignored'; reason: string };

// Same host restriction the validator enforces on SigningCertURL before it
// fetches AWS's public cert — applied again to SubscribeURL as defense in
// depth before we ever issue our own GET to it.
const SNS_HOST_PATTERN = /^sns\.[a-zA-Z0-9-]{3,}\.amazonaws\.com(\.cn)?$/;

const snsValidator = new MessageValidator();

/**
 * Verifies the RSA signature AWS SNS attaches to every delivered message
 * (fetching the signing cert only from an amazonaws.com host — never from an
 * attacker-suppliable URL). Without this, anyone who can reach this endpoint
 * could forge SubscriptionConfirmation (SSRF via SubscribeURL) or
 * Notification (fake bounce/complaint) payloads.
 */
function verifySnsMessage(rawPayload: string): Promise<SnsEnvelope> {
  return new Promise((resolve, reject) => {
    snsValidator.validate(rawPayload, (err, message) => {
      if (err || !message) {
        reject(err instanceof Error ? err : new Error('Invalid SNS signature'));
        return;
      }
      resolve(message as SnsEnvelope);
    });
  });
}

async function confirmSnsSubscription(subscribeUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(subscribeUrl);
  } catch {
    throw new Error('SNS SubscribeURL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' || !SNS_HOST_PATTERN.test(parsed.hostname)) {
    throw new Error('SNS SubscribeURL host is not a trusted AWS SNS endpoint');
  }
  const res = await fetch(subscribeUrl, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`SNS SubscribeURL confirm failed (${res.status})`);
  }
}

/**
 * Handle SNS → SES event webhook (SubscriptionConfirmation + Notification).
 */
export async function handleSesEmailWebhook(rawPayload: string): Promise<SesWebhookResult> {
  const envelope = await verifySnsMessage(rawPayload);

  if (envelope.Type === 'SubscriptionConfirmation') {
    if (!envelope.SubscribeURL) {
      throw new Error('SNS SubscriptionConfirmation missing SubscribeURL');
    }
    await confirmSnsSubscription(envelope.SubscribeURL);
    return { ok: true, kind: 'subscription_confirmed' };
  }

  if (envelope.Type === 'UnsubscribeConfirmation') {
    return { ok: true, kind: 'ignored', reason: 'unsubscribe' };
  }

  if (envelope.Type !== 'Notification' || !envelope.Message) {
    return { ok: true, kind: 'ignored', reason: 'unknown_sns_type' };
  }

  const event = parseSesEventFromSnsMessage(envelope.Message);
  const eventType = sesEventType(event);
  const status = mapSesEventToStatus(eventType);
  const messageId = extractSesMessageId(event);

  if (!status || !messageId) {
    return { ok: true, kind: 'notification', updated: false, eventType: eventType || undefined };
  }

  const detail = extractSesEventDetail(event);
  const result = await applyEmailLogProviderEvent({
    messageId,
    status,
    eventType: eventType || status,
    detail,
    metaKey: 'lastSesEvent',
  });

  // A complaint is an explicit "stop emailing me" signal; a permanent bounce
  // means the address is dead. Neither previously touched the Contact row —
  // the address stayed eligible for every future campaign indefinitely.
  if (result.contactId && result.workspaceId) {
    if (status === 'complained') {
      await markContactUnsubscribed(result.contactId, result.workspaceId);
    } else if (status === 'bounced' && event.bounce?.bounceType === 'Permanent') {
      await markContactBlocked(result.contactId, result.workspaceId);
    }
  }

  return {
    ok: true,
    kind: 'notification',
    updated: result.updated,
    eventType: result.eventType,
  };
}
