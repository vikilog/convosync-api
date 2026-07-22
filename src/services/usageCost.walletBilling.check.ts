/**
 * ponytail: wallet has no free included AI/email — billed = full charge.
 * Run: npx tsx backend/src/services/usageCost.walletBilling.check.ts
 */
import assert from 'node:assert/strict';
import { applyAiUsageMarkup, EMAIL_RATE_INR_PER_SEND } from './usageCost.constants.ts';

const aiRaw = 0.91;
const aiGross = applyAiUsageMarkup(aiRaw);
assert.equal(aiGross, 1.23);

const emailsSent = 3;
const emailBilled = emailsSent * EMAIL_RATE_INR_PER_SEND;
assert.equal(emailBilled, 3);

const waBilled = 1.3;
const monthTotal = Math.round((waBilled + aiGross + emailBilled) * 100) / 100;
assert.equal(monthTotal, 5.53);

console.log('usageCost.walletBilling.check.ts: ok');
