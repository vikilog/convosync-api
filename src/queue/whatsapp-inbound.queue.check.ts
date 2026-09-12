/**
 * Runnable check for WhatsApp inbound jobId helper.
 * Run: npx tsx src/queue/whatsapp-inbound.queue.check.ts
 */
import assert from 'node:assert/strict';
import { whatsappInboundJobId } from './whatsapp-inbound.queue.js';

assert.equal(whatsappInboundJobId({}), 'wa-inbound-unknown');
assert.equal(whatsappInboundJobId({ object: 'whatsapp_business_account' }), 'wa-inbound-unknown');

assert.equal(
  whatsappInboundJobId({
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.ABC' }] } }] }],
  }),
  'wa-inbound-wamid.ABC'
);

assert.equal(
  whatsappInboundJobId({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.STAT' }] } }] }],
  }),
  'wa-inbound-wamid.STAT'
);

assert.equal(
  whatsappInboundJobId({
    entry: [
      {
        changes: [
          { value: { statuses: [{ id: 'wamid.STAT', status: 'delivered', timestamp: '1710000060' }] } },
        ],
      },
    ],
  }),
  'wa-inbound-wamid.STAT-delivered-1710000060'
);

assert.notEqual(
  whatsappInboundJobId({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.STAT', status: 'sent' }] } }] }],
  }),
  whatsappInboundJobId({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.STAT', status: 'delivered' }] } }] }],
  })
);

assert.equal(
  whatsappInboundJobId({
    entry: [{ changes: [{ value: { message_echoes: [{ id: 'wamid.ECHO' }] } }] }],
  }),
  'wa-inbound-wamid.ECHO'
);

assert.equal(
  whatsappInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid.1' } }] }],
  }),
  'wa-inbound-mid.1'
);

assert.equal(
  whatsappInboundJobId({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: {} }] }],
  }),
  'wa-inbound-waba-1-messages'
);

assert.equal(
  whatsappInboundJobId({
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid:colon' }] } }] }],
  }),
  'wa-inbound-wamid-colon'
);

assert.ok(!whatsappInboundJobId({
  entry: [{ changes: [{ value: { messages: [{ id: 'wamid:x' }] } }] }],
}).includes(':'));

console.log('whatsapp-inbound.queue.check: ok');
