/**
 * ponytail: paid activation closes trial; active/planId wins over leftover trialEndsAt.
 * Run: npx tsx backend/src/services/trial.paidPriority.check.ts
 */
import assert from 'node:assert/strict';
import {
  hasPaidPlanPriority,
  paidActivationWorkspaceFields,
  serializeTrialInfo,
  subscriptionDisplayStatus,
  trialDaysLeft,
} from './trial.ts';

const futureEnd = new Date('2026-08-20T00:00:00.000Z');
const now = new Date('2026-08-06T12:00:00.000Z');

const stillTrial = {
  subscriptionStatus: 'trial',
  trialStartedAt: new Date('2026-08-01T00:00:00.000Z'),
  trialEndsAt: futureEnd,
  planId: null as string | null,
};
assert.equal(hasPaidPlanPriority(stillTrial), false);
assert.equal(subscriptionDisplayStatus(stillTrial, now), 'Trial');
assert.equal(trialDaysLeft(stillTrial, now), 14);

const paidFields = paidActivationWorkspaceFields();
assert.equal(paidFields.subscriptionStatus, 'active');
assert.equal(paidFields.trialEndsAt, null);

// Status active with leftover trialEndsAt (buggy activate path) → paid wins
const activeLeftoverTrialEnd = {
  ...stillTrial,
  subscriptionStatus: 'active',
  trialEndsAt: futureEnd,
  planId: 'plan_starter',
};
assert.equal(hasPaidPlanPriority(activeLeftoverTrialEnd), true);
assert.equal(subscriptionDisplayStatus(activeLeftoverTrialEnd, now), 'Active');
assert.equal(trialDaysLeft(activeLeftoverTrialEnd, now), 0);
const serializedActive = serializeTrialInfo(activeLeftoverTrialEnd, now);
assert.equal(serializedActive.isTrial, false);
assert.equal(serializedActive.trialEndsAt, null);
assert.equal(serializedActive.subscriptionStatus, 'active');

// Stale trial status but planId already attached → paid wins
const staleTrialWithPlan = {
  ...stillTrial,
  planId: 'plan_starter',
};
assert.equal(hasPaidPlanPriority(staleTrialWithPlan), true);
assert.equal(subscriptionDisplayStatus(staleTrialWithPlan, now), 'Active');
assert.equal(trialDaysLeft(staleTrialWithPlan, now), 0);
const serializedStale = serializeTrialInfo(staleTrialWithPlan, now);
assert.equal(serializedStale.isTrial, false);
assert.equal(serializedStale.trialEndsAt, null);

console.log('trial.paidPriority.check.ts: ok');
