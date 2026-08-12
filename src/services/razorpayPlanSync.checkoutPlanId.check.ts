/**
 * Run: npx tsx src/services/razorpayPlanSync.checkoutPlanId.check.ts
 */
import assert from 'node:assert/strict';
import { resolveCheckoutRazorpayPlanId } from './razorpayPlanSync.ts';

const plan = {
  slug: 'starter',
  razorpayPlanIdMonthly: 'plan_T5qg9PRwuD7zNW',
  razorpayPlanIdAnnual: 'plan_TON7pCB87fKfRI',
  razorpayPlanIdMonthlyUsd: 'plan_TOOEPNfN0VyoSw',
  razorpayPlanIdAnnualUsd: 'plan_TOOEPgNtk5EDEt',
};

assert.equal(
  resolveCheckoutRazorpayPlanId(plan, 'monthly', 'USD'),
  'plan_TOOEPNfN0VyoSw'
);
assert.equal(
  resolveCheckoutRazorpayPlanId(plan, 'annual', 'USD'),
  'plan_TOOEPgNtk5EDEt'
);
assert.equal(
  resolveCheckoutRazorpayPlanId(plan, 'monthly', 'INR'),
  'plan_T5qg9PRwuD7zNW'
);
assert.equal(
  resolveCheckoutRazorpayPlanId(
    { ...plan, razorpayPlanIdMonthlyUsd: null },
    'monthly',
    'USD'
  ),
  null
);

console.log('resolveCheckoutRazorpayPlanId check ok');
