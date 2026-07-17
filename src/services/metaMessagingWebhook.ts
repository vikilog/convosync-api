import {
  handleInstagramWebhookBody,
  type PageMessagingWebhookBody,
} from './instagramWebhookHandler.js';
import { handleMessengerWebhookBody } from './messengerWebhookHandler.js';
import { findInstagramAccountByEntryId } from './workspaceResolve.js';
import { findMessengerAccountByPageId } from './workspaceResolve.js';

type MessagingEvent = {
  message?: { messaging_product?: 'instagram' | 'facebook' };
};

/**
 * Instagram Page webhooks include messaging_product:"instagram".
 * Missing product → treat as Messenger when both channels are connected.
 */
function isInstagramMessagingEvent(event: MessagingEvent): boolean {
  return event.message?.messaging_product === 'instagram';
}

function isMessengerMessagingEvent(event: MessagingEvent): boolean {
  return event.message?.messaging_product !== 'instagram';
}

export async function handleMetaMessagingWebhook(body: PageMessagingWebhookBody) {
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

    // Both connected — split by messaging_product; also keep standby on Instagram path
    const messaging = entry.messaging || [];
    const standby = entry.standby || [];

    const instagramEntry = {
      ...entry,
      messaging: messaging.filter((event) => isInstagramMessagingEvent(event)),
      standby: standby.filter(
        (event) =>
          isInstagramMessagingEvent(event) ||
          // standby often omits messaging_product for IG; prefer IG when both apps exist
          !event.message?.messaging_product
      ),
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
