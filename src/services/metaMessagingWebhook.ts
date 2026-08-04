import {
  handleInstagramWebhookBody,
  type PageMessagingWebhookBody,
} from './instagramWebhookHandler.js';
import { handleMessengerWebhookBody } from './messengerWebhookHandler.js';
import { handleInstagramCommentWebhookBody } from './instagramCommentWebhook.service.js';
import { findInstagramAccountByEntryId } from './workspaceResolve.js';
import { findMessengerAccountByPageId } from './workspaceResolve.js';

type MessagingEvent = {
  message?: { messaging_product?: 'instagram' | 'facebook' };
  read?: { mid?: string; watermark?: number };
};

/** Instagram DMs (messages or messaging_seen with mid). */
function isInstagramMessagingEvent(event: MessagingEvent): boolean {
  if (event.read?.mid) return true;
  if (!event.message) return false;
  const product = event.message.messaging_product;
  // Meta often omits messaging_product on IG DMs — treat missing as Instagram.
  return product === 'instagram' || product == null;
}

/** Messenger DMs (messages or message_reads with watermark). */
function isMessengerMessagingEvent(event: MessagingEvent): boolean {
  if (event.read?.watermark != null && !event.read?.mid) return true;
  if (event.read?.mid) return false; // Instagram seen uses mid
  // Only explicit Facebook/Messenger product — never steal omitted-product IG DMs.
  const product = event.message?.messaging_product;
  return product === 'facebook' || product === 'messenger';
}

export async function handleMetaMessagingWebhook(body: PageMessagingWebhookBody) {
  // ponytail: temporary — inspect raw Meta IG/Page webhook payload
  console.log('[Instagram Webhook] raw payload', JSON.stringify(body, null, 2));

  // Social Listening: comments / live_comments (object=instagram or page)
  await handleInstagramCommentWebhookBody(body);

  if (body.object === 'instagram') {
    await handleInstagramWebhookBody(body);
    return;
  }

  if (body.object !== 'page') {
    return;
  }

  for (const entry of body.entry || []) {
    const entryId = entry.id;
    if (!entryId) continue;

    const [instagramAccount, messengerAccount] = await Promise.all([
      findInstagramAccountByEntryId(entryId),
      findMessengerAccountByPageId(entryId),
    ]);

    const hasInstagram = !!instagramAccount;
    const hasMessenger = !!messengerAccount;

    if (!hasInstagram && !hasMessenger) continue;

    if (hasInstagram && !hasMessenger) {
      await handleInstagramWebhookBody({ object: 'page', entry: [entry] });
      continue;
    }

    if (hasMessenger && !hasInstagram) {
      await handleMessengerWebhookBody({ object: 'page', entry: [entry] });
      continue;
    }

    // Both connected — split by messaging_product; seen/reads by mid vs watermark
    const messaging = entry.messaging || [];
    const standby = entry.standby || [];

    const instagramEntry = {
      ...entry,
      messaging: messaging.filter((event) => isInstagramMessagingEvent(event)),
      standby: standby.filter((event) => isInstagramMessagingEvent(event)),
    };
    const messengerEntry = {
      ...entry,
      messaging: messaging.filter((event) => isMessengerMessagingEvent(event)),
      standby: [] as typeof standby,
    };

    if (
      (instagramEntry.messaging?.length ?? 0) > 0 ||
      (instagramEntry.standby?.length ?? 0) > 0
    ) {
      await handleInstagramWebhookBody({ object: 'page', entry: [instagramEntry] });
    }
    if ((messengerEntry.messaging?.length ?? 0) > 0) {
      await handleMessengerWebhookBody({ object: 'page', entry: [messengerEntry] });
    }
  }
}

export type { PageMessagingWebhookBody };
