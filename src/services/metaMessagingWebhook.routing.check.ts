/**
 * Runnable check: Meta IG vs Messenger event routing on object=page.
 * Run: npx tsx src/services/metaMessagingWebhook.routing.check.ts
 */
import assert from 'node:assert/strict';
import {
  isInstagramMessagingEvent,
  isMessengerMessagingEvent,
} from './metaMessagingRoute.js';

const igCtx = { pageId: 'page-1', instagramUserId: 'ig-biz-1' };

// Classic Messenger Page DM — no messaging_product
assert.equal(isInstagramMessagingEvent({ message: {} }, igCtx), false, 'omitted ↛ IG');
assert.equal(isMessengerMessagingEvent({ message: {} }, igCtx), true, 'omitted → Messenger');

assert.equal(
  isInstagramMessagingEvent({ message: { messaging_product: 'instagram' } }, igCtx),
  true
);
assert.equal(
  isMessengerMessagingEvent({ message: { messaging_product: 'instagram' } }, igCtx),
  false
);
assert.equal(
  isMessengerMessagingEvent({ message: { messaging_product: 'facebook' } }, igCtx),
  true
);
assert.equal(
  isInstagramMessagingEvent({ message: { messaging_product: 'facebook' } }, igCtx),
  false
);

// Omitted product but addressed to IG business id → Instagram
assert.equal(
  isInstagramMessagingEvent(
    { recipient: { id: 'ig-biz-1' }, message: {} },
    igCtx
  ),
  true,
  'recipient IG id → IG'
);
assert.equal(
  isMessengerMessagingEvent(
    { recipient: { id: 'ig-biz-1' }, message: {} },
    igCtx
  ),
  false,
  'recipient IG id ↛ Messenger'
);

// Reads
assert.equal(isInstagramMessagingEvent({ read: { mid: 'm1' } }, igCtx), true);
assert.equal(isMessengerMessagingEvent({ read: { mid: 'm1' } }, igCtx), false);
assert.equal(
  isMessengerMessagingEvent({ read: { watermark: 123 } }, igCtx),
  true
);
assert.equal(
  isInstagramMessagingEvent({ read: { watermark: 123 } }, igCtx),
  false
);

console.log('metaMessagingWebhook.routing check ok');
