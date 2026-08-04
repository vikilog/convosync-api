/**
 * Runnable check: Meta IG vs Messenger event routing (omitted messaging_product).
 * Run: npx tsx src/services/metaMessagingWebhook.routing.check.ts
 */
import assert from 'node:assert/strict';

type MessagingEvent = {
  message?: { messaging_product?: 'instagram' | 'facebook' };
  read?: { mid?: string; watermark?: number };
};

function isInstagramMessagingEvent(event: MessagingEvent): boolean {
  if (event.read?.mid) return true;
  if (!event.message) return false;
  const product = event.message.messaging_product;
  return product === 'instagram' || product == null;
}

function isMessengerMessagingEvent(event: MessagingEvent): boolean {
  if (event.read?.watermark != null && !event.read?.mid) return true;
  if (event.read?.mid) return false;
  const product = event.message?.messaging_product;
  return product === 'facebook' || product === 'messenger';
}

assert.equal(isInstagramMessagingEvent({ message: {} }), true, 'omitted product → IG');
assert.equal(isMessengerMessagingEvent({ message: {} }), false, 'omitted product ↛ Messenger');
assert.equal(
  isInstagramMessagingEvent({ message: { messaging_product: 'instagram' } }),
  true
);
assert.equal(
  isMessengerMessagingEvent({ message: { messaging_product: 'facebook' } }),
  true
);
assert.equal(
  isInstagramMessagingEvent({ message: { messaging_product: 'facebook' } }),
  false
);

console.log('metaMessagingWebhook.routing check ok');
