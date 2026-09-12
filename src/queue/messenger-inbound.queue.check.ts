/**
 * Runnable check for Messenger inbound jobId helper.
 * Run: npx tsx src/queue/messenger-inbound.queue.check.ts
 */
import assert from 'node:assert/strict';
import { messengerInboundJobId } from './messenger-inbound.queue.js';

assert.equal(messengerInboundJobId({}), 'msgr-inbound-unknown');
assert.equal(messengerInboundJobId({ object: 'page' }), 'msgr-inbound-unknown');

assert.equal(
  messengerInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid.MS1' } }] }],
  }),
  'msgr-inbound-mid.MS1'
);

assert.equal(
  messengerInboundJobId({
    entry: [{ messaging: [{ postback: { mid: 'mid.PB' } }] }],
  }),
  'msgr-inbound-mid.PB'
);

assert.equal(
  messengerInboundJobId({
    object: 'page',
    entry: [{ id: 'page-1', changes: [{ field: 'feed', value: {} }] }],
  }),
  'msgr-inbound-page-1-feed'
);

assert.equal(
  messengerInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid:colon' } }] }],
  }),
  'msgr-inbound-mid-colon'
);

assert.ok(
  !messengerInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid:x' } }] }],
  }).includes(':')
);

assert.equal(
  messengerInboundJobId({
    entry: [{ messaging: [{ read: { watermark: 1710000060 }, timestamp: 1710000060 }] }],
  }),
  'msgr-inbound-1710000060-read-1710000060'
);

assert.notEqual(
  messengerInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid.STAT' } }] }],
  }),
  messengerInboundJobId({
    entry: [{ messaging: [{ read: { mid: 'mid.STAT' }, timestamp: 1710000060 }] }],
  })
);

assert.notEqual(
  messengerInboundJobId({
    entry: [{ messaging: [{ delivery: { mids: ['mid.STAT'] }, timestamp: 1710000060 }] }],
  }),
  messengerInboundJobId({
    entry: [{ messaging: [{ read: { mid: 'mid.STAT' }, timestamp: 1710000060 }] }],
  })
);

console.log('messenger-inbound.queue.check: ok');
