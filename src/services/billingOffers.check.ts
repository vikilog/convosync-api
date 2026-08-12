/**
 * Runnable self-check for BillingOffer mapping / amount guards / checkout kind (no Razorpay / DB).
 * Run: npx tsx src/services/billingOffers.check.ts
 */
import assert from 'node:assert/strict';
import { minCheckoutMinor, planAmountMinor } from './billingCurrency.ts';
import { resolveOfferCheckoutKind } from './billingOfferCheckoutKind.ts';
import { razorpayCancelTargets } from './billingOffers.ts';

const plan = {
  priceMonthlyPaise: 199_900,
  priceAnnualPaise: 1_999_000,
  priceMonthlyCents: 2900,
  priceAnnualCents: 29_000,
};

assert.equal(planAmountMinor(plan, 'monthly', 'INR'), 199_900);
assert.equal(planAmountMinor(plan, 'monthly', 'USD'), 2900);
assert.ok(minCheckoutMinor('INR') <= 199_900);
assert.ok(minCheckoutMinor('USD') <= 2900);

// Custom override must be distinguishable from catalog
const customUsd = 1999;
assert.notEqual(customUsd, planAmountMinor(plan, 'monthly', 'USD'));

assert.deepEqual(
  resolveOfferCheckoutKind({
    checkoutKind: 'subscription',
    allowPaymentLinkFallback: false,
    subscriptionFailed: false,
  }),
  { kind: 'subscription' }
);

assert.deepEqual(
  resolveOfferCheckoutKind({
    checkoutKind: 'payment_link',
    allowPaymentLinkFallback: false,
    subscriptionFailed: false,
  }),
  { kind: 'payment_link' }
);

const fallback = resolveOfferCheckoutKind({
  checkoutKind: 'subscription',
  allowPaymentLinkFallback: true,
  subscriptionFailed: true,
  subscriptionErrorMessage: 'Validation failed',
});
assert.equal(fallback.kind, 'payment_link');
assert.equal(fallback.fallbackReason, 'Validation failed');

assert.throws(
  () =>
    resolveOfferCheckoutKind({
      checkoutKind: 'subscription',
      allowPaymentLinkFallback: false,
      subscriptionFailed: true,
      subscriptionErrorMessage: 'Validation failed',
    }),
  /Validation failed/
);

assert.deepEqual(
  razorpayCancelTargets({
    status: 'pending',
    razorpaySubscriptionId: 'sub_1',
    razorpayPaymentLinkId: null,
  }),
  { subscriptionId: 'sub_1' }
);
assert.deepEqual(
  razorpayCancelTargets({
    status: 'cancelled',
    razorpaySubscriptionId: null,
    razorpayPaymentLinkId: 'plink_1',
  }),
  { paymentLinkId: 'plink_1' }
);
assert.deepEqual(
  razorpayCancelTargets({
    status: 'paid',
    razorpaySubscriptionId: 'sub_paid',
    razorpayPaymentLinkId: 'plink_paid',
  }),
  {}
);

console.log('billingOffers.check ok');
