import {
  handleInstagramWebhookBody,
  type PageMessagingWebhookBody,
} from './instagramWebhookHandler.js';
import { handleMessengerWebhookBody } from './messengerWebhookHandler.js';
import { findInstagramAccountByEntryId } from './workspaceResolve.js';
import { findMessengerAccountByPageId } from './workspaceResolve.js';

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

    const instagramEntry = {
      ...entry,
      messaging: (entry.messaging || []).filter(
        (event) => event.message?.messaging_product === 'instagram'
      ),
    };
    const messengerEntry = {
      ...entry,
      messaging: (entry.messaging || []).filter(
        (event) => event.message?.messaging_product !== 'instagram'
      ),
    };

    if (instagramEntry.messaging.length > 0) {
      await handleInstagramWebhookBody({ object: 'page', entry: [instagramEntry] });
    }
    if (messengerEntry.messaging.length > 0) {
      await handleMessengerWebhookBody({ object: 'page', entry: [messengerEntry] });
    }
  }
}

export type { PageMessagingWebhookBody };
