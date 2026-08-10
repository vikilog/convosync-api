import {
  handleInstagramWebhookBody,
  type PageMessagingWebhookBody,
} from './instagramWebhookHandler.js';
import { handleMessengerWebhookBody } from './messengerWebhookHandler.js';
import { handleInstagramCommentWebhookBody } from './instagramCommentWebhook.service.js';
import { findInstagramAccountByEntryId } from './workspaceResolve.js';
import { findMessengerAccountByPageId } from './workspaceResolve.js';
import {
  isInstagramMessagingEvent,
  isMessengerMessagingEvent,
  type MetaMessagingRouteCtx,
} from './metaMessagingRoute.js';

export {
  isInstagramMessagingEvent,
  isMessengerMessagingEvent,
  type MetaMessagingEvent,
  type MetaMessagingRouteCtx,
} from './metaMessagingRoute.js';

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
      await handleMessengerWebhookBody(
        { object: 'page', entry: [entry] },
        { pageId: messengerAccount!.pageId }
      );
      continue;
    }

    // Both connected — split by messaging_product / recipient / read shape
    const routeCtx: MetaMessagingRouteCtx = {
      pageId: messengerAccount!.pageId || instagramAccount!.pageId,
      instagramUserId: instagramAccount!.instagramUserId,
    };
    const messaging = entry.messaging || [];
    const standby = entry.standby || [];

    const instagramEntry = {
      ...entry,
      messaging: messaging.filter((event) => isInstagramMessagingEvent(event, routeCtx)),
      standby: standby.filter((event) => isInstagramMessagingEvent(event, routeCtx)),
    };
    const messengerEntry = {
      ...entry,
      messaging: messaging.filter((event) => isMessengerMessagingEvent(event, routeCtx)),
      standby: [] as typeof standby,
    };

    if (
      (instagramEntry.messaging?.length ?? 0) > 0 ||
      (instagramEntry.standby?.length ?? 0) > 0
    ) {
      await handleInstagramWebhookBody({ object: 'page', entry: [instagramEntry] });
    }
    if ((messengerEntry.messaging?.length ?? 0) > 0) {
      await handleMessengerWebhookBody(
        { object: 'page', entry: [messengerEntry] },
        routeCtx
      );
    }
  }
}

export type { PageMessagingWebhookBody };
