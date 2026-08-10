/**
 * Run: npx tsx src/services/campaignAnalytics.check.ts
 */
import assert from 'node:assert/strict';
import {
  bucketLag,
  buildCumulativeDeliverySeries,
  completionTiming,
  extractLagSamples,
  firstEventAt,
  firstSentMs,
  medianMs,
  parseEvents,
  successRate,
} from './campaignAnalytics.js';

assert.equal(medianMs([]), null);
assert.equal(medianMs([10]), 10);
assert.equal(medianMs([10, 30]), 20);
assert.equal(medianMs([10, 20, 30]), 20);

const lag = extractLagSamples(
  [
    {
      status: 'read',
      sentAtMs: Date.parse('2024-01-01T00:00:00.000Z'),
      events: [
        { type: 'sent', at: '2024-01-01T00:00:00.000Z' },
        { type: 'delivered', at: '2024-01-01T00:02:00.000Z' },
        { type: 'read', at: '2024-01-01T00:05:00.000Z' },
      ],
    },
    {
      status: 'delivered',
      sentAtMs: Date.parse('2024-01-01T00:00:00.000Z'),
      events: [
        { type: 'sent', at: '2024-01-01T00:00:00.000Z' },
        { type: 'delivered', at: '2024-01-01T00:01:00.000Z' },
      ],
    },
  ],
  { readTypes: ['read'] }
);
assert.equal(lag.lagAvailable, true);
assert.deepEqual(lag.sendToDelivered, [120_000, 60_000]);
assert.deepEqual(lag.deliveredToRead, [180_000]);
assert.equal(medianMs(lag.sendToDelivered), 90_000);

const hist = bucketLag([30_000, 120_000, 10 * 60_000]);
assert.equal(hist.buckets.find((b) => b.label === '<1m')!.count, 1);
assert.equal(hist.buckets.find((b) => b.label === '1–5m')!.count, 1);
assert.equal(hist.buckets.find((b) => b.label === '5–15m')!.count, 1);

assert.equal(successRate(80, 100, 10), 80);
assert.equal(successRate(0, 0, 5), 0);

const events = parseEvents({
  events: [{ type: 'Delivered', at: '2024-01-01T00:00:00.000Z' }, { bad: true }],
});
assert.equal(events.length, 1);
assert.equal(events[0]!.type, 'delivered');

// Dispatch complete: end = max(first sent), later read/delivered irrelevant
const done = completionTiming({
  startedAt: new Date('2024-01-01T00:00:00.000Z'),
  recipients: [
    {
      status: 'read',
      sentAtMs: Date.parse('2024-01-01T00:01:00.000Z'),
      events: [
        { type: 'sent', at: '2024-01-01T00:01:00.000Z' },
        { type: 'read', at: '2024-01-01T00:10:00.000Z' },
      ],
    },
    {
      status: 'failed',
      sentAtMs: Date.parse('2024-01-01T00:03:00.000Z'),
      events: [
        { type: 'sent', at: '2024-01-01T00:03:00.000Z' },
        { type: 'failed', at: '2024-01-01T00:20:00.000Z' },
      ],
    },
  ],
});
assert.equal(done.durationMs, 3 * 60_000);
assert.equal(done.durationLabel, '3m');
assert.equal(done.completedAt, '2024-01-01T00:03:00.000Z');

// Pending until every recipient has a first send (status `sent` alone with no time is not enough —
// but sentAtMs / sent event counts)
const pending = completionTiming({
  startedAt: new Date('2024-01-01T00:00:00.000Z'),
  recipients: [
    {
      status: 'sent',
      sentAtMs: Date.parse('2024-01-01T00:01:00.000Z'),
      events: [{ type: 'sent', at: '2024-01-01T00:01:00.000Z' }],
    },
    { status: 'pending', sentAtMs: NaN, events: [] },
  ],
});
assert.equal(pending.completedAt, null);

// Historical row: no events timeline → fall back to sentAtMs once left pending
const histFallback = completionTiming({
  startedAt: new Date('2024-01-01T00:00:00.000Z'),
  recipients: [
    { status: 'sent', sentAtMs: Date.parse('2024-01-01T00:01:00.000Z'), events: [] },
  ],
});
assert.equal(histFallback.durationMs, 60_000);

// Resend must not move completion end past the original first `sent`
assert.equal(
  firstSentMs({
    status: 'resent',
    sentAtMs: Date.parse('2024-01-01T00:01:00.000Z'),
    events: [
      { type: 'sent', at: '2024-01-01T00:01:00.000Z' },
      { type: 'failed', at: '2024-01-01T00:02:00.000Z' },
      { type: 'resent', at: '2024-01-01T01:00:00.000Z' },
    ],
  }),
  Date.parse('2024-01-01T00:01:00.000Z')
);
const ignoreResend = completionTiming({
  startedAt: new Date('2024-01-01T00:00:00.000Z'),
  recipients: [
    {
      status: 'resent',
      sentAtMs: Date.parse('2024-01-01T00:01:00.000Z'),
      events: [
        { type: 'sent', at: '2024-01-01T00:01:00.000Z' },
        { type: 'resent', at: '2024-01-01T01:00:00.000Z' },
      ],
    },
  ],
});
assert.equal(ignoreResend.durationMs, 60_000);

assert.equal(
  firstEventAt(
    [
      { type: 'sent', at: '2024-01-01T00:00:00.000Z' },
      { type: 'delivered', at: '2024-01-01T00:02:00.000Z' },
    ],
    ['delivered']
  ),
  '2024-01-01T00:02:00.000Z'
);
assert.equal(firstEventAt([{ type: 'sent', at: '2024-01-01T00:00:00.000Z' }], ['delivered']), null);

// Cumulative delivery pace: sort ascending, skip nulls, count 1..n
assert.deepEqual(
  buildCumulativeDeliverySeries([
    null,
    '2024-01-01T00:03:00.000Z',
    '2024-01-01T00:01:00.000Z',
    'bad',
    '2024-01-01T00:02:00.000Z',
  ]),
  [
    { at: '2024-01-01T00:01:00.000Z', cumulative: 1 },
    { at: '2024-01-01T00:02:00.000Z', cumulative: 2 },
    { at: '2024-01-01T00:03:00.000Z', cumulative: 3 },
  ]
);
assert.deepEqual(buildCumulativeDeliverySeries([]), []);

console.log('campaignAnalytics.check: ok');
