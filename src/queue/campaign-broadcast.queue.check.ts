/**
 * Runnable check for schedule delay + edit gate helpers.
 * Run: npx tsx src/queue/campaign-broadcast.queue.check.ts
 */
import assert from 'node:assert/strict';
import {
  campaignScheduleDelayMs,
  isScheduledCampaignEditable,
  SCHEDULED_CAMPAIGN_EDIT_LEAD_MS,
} from './campaign-broadcast.queue.js';

assert.equal(campaignScheduleDelayMs(null), 0);
assert.equal(campaignScheduleDelayMs(undefined), 0);
assert.equal(campaignScheduleDelayMs('not-a-date'), 0);

const past = new Date(Date.now() - 60_000);
assert.equal(campaignScheduleDelayMs(past), 0);

const future = new Date(Date.now() + 120_000);
const delay = campaignScheduleDelayMs(future);
assert.ok(delay >= 110_000 && delay <= 120_000, `expected ~120s delay, got ${delay}`);

const now = Date.now();
assert.equal(isScheduledCampaignEditable('scheduled', new Date(now + SCHEDULED_CAMPAIGN_EDIT_LEAD_MS + 1_000), now), true);
assert.equal(isScheduledCampaignEditable('Scheduled', new Date(now + SCHEDULED_CAMPAIGN_EDIT_LEAD_MS + 1_000), now), true);
assert.equal(isScheduledCampaignEditable('scheduled', new Date(now + SCHEDULED_CAMPAIGN_EDIT_LEAD_MS), now), false);
assert.equal(isScheduledCampaignEditable('scheduled', new Date(now + 5 * 60 * 1000), now), false);
// Draft is always editable — never sent, no in-flight job to race against.
assert.equal(isScheduledCampaignEditable('draft', new Date(now + 60 * 60 * 1000), now), true);
assert.equal(isScheduledCampaignEditable('draft', null, now), true);
assert.equal(isScheduledCampaignEditable('Draft', null, now), true);
assert.equal(isScheduledCampaignEditable('scheduled', null, now), false);
for (const status of ['running', 'completed', 'failed', 'cancelled']) {
  assert.equal(
    isScheduledCampaignEditable(status, new Date(now + 60 * 60 * 1000), now),
    false,
    `${status} must not be editable`
  );
}

console.log('campaign-broadcast.queue.check: ok');
