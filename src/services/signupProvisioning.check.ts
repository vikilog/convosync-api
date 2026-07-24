/**
 * ponytail: new customers get a 14-day trial window + 100 CC welcome credit math.
 * Run: npx tsx backend/src/services/signupProvisioning.check.ts
 */
import assert from 'node:assert/strict';
import { DEFAULT_TRIAL_DAYS, newCustomerTrialFields, trialDaysLeft } from './trial.ts';
import { SIGNUP_WALLET_CREDIT_CC, SIGNUP_WALLET_CREDIT_PAISE } from './wallet.constants.ts';

assert.equal(DEFAULT_TRIAL_DAYS, 14);
assert.equal(SIGNUP_WALLET_CREDIT_CC, 100);
assert.equal(SIGNUP_WALLET_CREDIT_PAISE, 10_000);

const startedAt = new Date('2026-07-01T00:00:00.000Z');
const fields = newCustomerTrialFields(startedAt, DEFAULT_TRIAL_DAYS);
assert.equal(fields.subscriptionStatus, 'trial');
assert.equal(fields.planId, null);
assert.equal(fields.trialStartedAt.toISOString(), '2026-07-01T00:00:00.000Z');
assert.equal(fields.trialEndsAt.toISOString(), '2026-07-15T00:00:00.000Z');

const midTrial = new Date('2026-07-05T12:00:00.000Z');
assert.equal(trialDaysLeft(fields, midTrial), 10);

console.log('signupProvisioning.check.ts: ok');
