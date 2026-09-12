import { handleMetaMessagingWebhook } from './metaMessagingWebhook.js';
import { type PageMessagingWebhookBody } from './instagramWebhookHandler.js';
import { logMessengerWebhook } from './messengerWebhookHandler.js';
import type { MessengerInboundWebhookBody } from '../queue/messenger-inbound.queue.js';

/**
 * HMAC already verified on the HTTP path. Worker runs page messaging / comments / AI.
 */
export async function processMessengerInboundWebhook(
  body: MessengerInboundWebhookBody
): Promise<void> {
  logMessengerWebhook('POST payload', body);
  await handleMetaMessagingWebhook(body as PageMessagingWebhookBody);
}
