import assert from 'node:assert/strict';
import {
  isSkippedInbound,
  parseInboundWhatsAppMessage,
} from './whatsappMedia.js';

const base = { id: 'wamid.test', from: '15551234567' };

// Part 1 — genuine Meta unsupported must skip persistence.
const skipped = parseInboundWhatsAppMessage({
  ...base,
  type: 'unsupported',
  errors: [{ code: 131051, title: 'Unsupported message type' }],
});
assert.equal(isSkippedInbound(skipped), true);

// Part 2 — five known types.
const list = parseInboundWhatsAppMessage({
  ...base,
  type: 'interactive',
  interactive: {
    type: 'list_reply',
    list_reply: { id: 'opt_1', title: 'Pricing', description: 'See rates' },
  },
});
assert.equal(isSkippedInbound(list), false);
if (!isSkippedInbound(list)) {
  assert.equal(list.buttonPayload, 'opt_1');
  assert.match(list.content, /Pricing/);
  assert.match(list.content, /See rates/);
}

const order = parseInboundWhatsAppMessage({
  ...base,
  type: 'order',
  order: {
    catalog_id: 'cat1',
    product_items: [
      { product_retailer_id: 'SKU-A', quantity: 2, item_price: 100, currency: 'INR' },
      { product_retailer_id: 'SKU-B', quantity: 1, item_price: 50, currency: 'INR' },
    ],
  },
});
assert.equal(isSkippedInbound(order), false);
if (!isSkippedInbound(order)) {
  assert.match(order.content, /SKU-A/);
  assert.match(order.content, /Total: INR 250/);
}

const system = parseInboundWhatsAppMessage({
  ...base,
  type: 'system',
  system: { body: 'User changed their phone number', type: 'user_changed_number' },
});
assert.equal(isSkippedInbound(system), false);
if (!isSkippedInbound(system)) {
  assert.equal(system.sender, 'system');
  assert.equal(system.content, 'User changed their phone number');
}

const reaction = parseInboundWhatsAppMessage({
  ...base,
  type: 'reaction',
  reaction: { message_id: 'wamid.orig', emoji: '❤️' },
});
assert.equal(isSkippedInbound(reaction), false);
if (!isSkippedInbound(reaction)) {
  assert.equal(reaction.content, '❤️ reacted to a message');
  assert.equal(reaction.reaction?.reactedToWaMessageId, 'wamid.orig');
}

const contacts = parseInboundWhatsAppMessage({
  ...base,
  type: 'contacts',
  contacts: [
    {
      name: { formatted_name: 'Ada Lovelace' },
      phones: [{ phone: '+15550001111' }],
    },
  ],
});
assert.equal(isSkippedInbound(contacts), false);
if (!isSkippedInbound(contacts)) {
  assert.equal(contacts.content, 'Shared contact: Ada Lovelace (+15550001111)');
}

// Existing media stubs still work; never bare [media].
assert.equal(
  (parseInboundWhatsAppMessage({ ...base, type: 'image' }) as { content: string }).content,
  '📷 Photo'
);
assert.notEqual(
  (parseInboundWhatsAppMessage({ ...base, type: 'button' }) as { content: string }).content,
  '[media]'
);

console.log('whatsappMedia.parse.check: ok');
