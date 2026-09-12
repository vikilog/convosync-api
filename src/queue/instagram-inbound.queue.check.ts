/**
 * Runnable check for Instagram inbound jobId helper.
 * Run: npx tsx src/queue/instagram-inbound.queue.check.ts
 */
import assert from 'node:assert/strict';
import { instagramInboundJobId } from './instagram-inbound.queue.js';

assert.equal(instagramInboundJobId({}), 'ig-inbound-unknown');
assert.equal(instagramInboundJobId({ object: 'instagram' }), 'ig-inbound-unknown');

assert.equal(
  instagramInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid.IG1' } }] }],
  }),
  'ig-inbound-mid.IG1'
);

assert.equal(
  instagramInboundJobId({
    entry: [{ messaging: [{ postback: { mid: 'mid.PB' } }] }],
  }),
  'ig-inbound-mid.PB'
);

assert.equal(
  instagramInboundJobId({
    entry: [{ standby: [{ message: { mid: 'mid.SB' } }] }],
  }),
  'ig-inbound-mid.SB'
);

assert.equal(
  instagramInboundJobId({
    entry: [{ changes: [{ value: { comment_id: 'cmt.1' } }] }],
  }),
  'ig-inbound-cmt.1'
);

assert.equal(
  instagramInboundJobId({
    object: 'instagram',
    entry: [{ id: 'ig-1', changes: [{ field: 'comments', value: {} }] }],
  }),
  'ig-inbound-ig-1-comments'
);

assert.equal(
  instagramInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid:colon' } }] }],
  }),
  'ig-inbound-mid-colon'
);

assert.ok(
  !instagramInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid:x' } }] }],
  }).includes(':')
);

assert.equal(
  instagramInboundJobId({
    entry: [{ messaging: [{ read: { mid: 'mid.STAT' }, timestamp: 1710000060 }] }],
  }),
  'ig-inbound-mid.STAT-read-1710000060'
);

assert.notEqual(
  instagramInboundJobId({
    entry: [{ messaging: [{ message: { mid: 'mid.STAT' } }] }],
  }),
  instagramInboundJobId({
    entry: [{ messaging: [{ read: { mid: 'mid.STAT' }, timestamp: 1710000060 }] }],
  })
);

assert.notEqual(
  instagramInboundJobId({
    entry: [{ messaging: [{ delivery: { mids: ['mid.STAT'] }, timestamp: 1710000060 }] }],
  }),
  instagramInboundJobId({
    entry: [{ messaging: [{ read: { mid: 'mid.STAT' }, timestamp: 1710000060 }] }],
  })
);

console.log('instagram-inbound.queue.check: ok');
