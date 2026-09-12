import { handleMetaMessagingWebhook } from './metaMessagingWebhook.js';
import { logInstagramWebhook, type PageMessagingWebhookBody } from './instagramWebhookHandler.js';
import type { InstagramInboundWebhookBody } from '../queue/instagram-inbound.queue.js';

/**
 * HMAC already verified on the HTTP path. Worker runs comments / messaging / AI.
 */
export async function processInstagramInboundWebhook(
  body: InstagramInboundWebhookBody
): Promise<void> {
  logInstagramWebhook('POST payload', body);
  await handleMetaMessagingWebhook(body as PageMessagingWebhookBody);
}
