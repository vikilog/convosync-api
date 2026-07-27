/**
 * Runnable check for schedule delay helper.
 * Run: npx tsx src/queue/campaign-broadcast.queue.check.ts
 */
import assert from 'node:assert/strict';
import { campaignScheduleDelayMs } from './campaign-broadcast.queue.js';

assert.equal(campaignScheduleDelayMs(null), 0);
assert.equal(campaignScheduleDelayMs(undefined), 0);
assert.equal(campaignScheduleDelayMs('not-a-date'), 0);

const past = new Date(Date.now() - 60_000);
assert.equal(campaignScheduleDelayMs(past), 0);

const future = new Date(Date.now() + 120_000);
const delay = campaignScheduleDelayMs(future);
assert.ok(delay >= 110_000 && delay <= 120_000, `expected ~120s delay, got ${delay}`);

console.log('campaign-broadcast.queue.check: ok');
