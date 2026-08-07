import {
  extractSesEventDetail,
  extractSesMessageId,
  mapSesEventToStatus,
  parseSesEventFromSnsMessage,
  parseSnsEnvelope,
  sesEventType,
} from '../utils/ses-event-parser.js';
import { applyEmailLogProviderEvent } from './email-log-events.service.js';

export type SesWebhookResult =
  | { ok: true; kind: 'subscription_confirmed' }
  | { ok: true; kind: 'notification'; updated: boolean; eventType?: string }
  | { ok: true; kind: 'ignored'; reason: string };

async function confirmSnsSubscription(subscribeUrl: string): Promise<void> {
  const res = await fetch(subscribeUrl, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`SNS SubscribeURL confirm failed (${res.status})`);
  }
}

/**
 * Handle SNS → SES event webhook (SubscriptionConfirmation + Notification).
 */
export async function handleSesEmailWebhook(rawPayload: string): Promise<SesWebhookResult> {
  const envelope = parseSnsEnvelope(rawPayload);

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

  return {
    ok: true,
    kind: 'notification',
    updated: result.updated,
    eventType: result.eventType,
  };
}
