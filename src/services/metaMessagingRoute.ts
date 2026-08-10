export type MetaMessagingRouteCtx = {
  pageId?: string;
  /** Instagram business account id — when set, omitted-product events addressed to it are IG. */
  instagramUserId?: string | null;
};

export type MetaMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { messaging_product?: 'instagram' | 'facebook' | 'messenger' };
  postback?: { payload?: string; mid?: string; messaging_product?: 'instagram' | 'facebook' | 'messenger' };
  read?: { mid?: string; watermark?: number };
};

function messagingProduct(
  event: MetaMessagingEvent
): 'instagram' | 'facebook' | 'messenger' | undefined {
  return event.message?.messaging_product ?? event.postback?.messaging_product;
}

function addressedToInstagram(
  event: MetaMessagingEvent,
  ctx?: MetaMessagingRouteCtx
): boolean {
  const igId = ctx?.instagramUserId?.trim();
  if (!igId) return false;
  // Inbound: recipient is the business; echoes: sender is the business.
  return event.recipient?.id === igId || event.sender?.id === igId;
}

/**
 * Page webhook split: IG vs Messenger.
 * - Explicit messaging_product (message or postback) wins.
 * - IG messaging_seen uses read.mid; Messenger message_reads uses watermark.
 * - Omitted product on object=page is Messenger (classic Page DM), unless
 *   recipient/sender is the IG business id.
 * object=instagram is handled before this split and never reaches here.
 */
export function isInstagramMessagingEvent(
  event: MetaMessagingEvent,
  ctx?: MetaMessagingRouteCtx
): boolean {
  if (event.read?.mid) return true;
  if (event.read?.watermark != null && !event.read?.mid) return false;

  const product = messagingProduct(event);
  if (product === 'instagram') return true;
  if (product === 'facebook' || product === 'messenger') return false;

  // Omitted product — only claim IG when clearly addressed to the IG business account.
  return addressedToInstagram(event, ctx);
}

export function isMessengerMessagingEvent(
  event: MetaMessagingEvent,
  ctx?: MetaMessagingRouteCtx
): boolean {
  if (event.read?.watermark != null && !event.read?.mid) return true;
  if (event.read?.mid) return false;

  const product = messagingProduct(event);
  if (product === 'instagram') return false;
  if (product === 'facebook' || product === 'messenger') return true;

  // Omitted product → Messenger, unless addressed to IG business id.
  if (addressedToInstagram(event, ctx)) return false;
  return true;
}
