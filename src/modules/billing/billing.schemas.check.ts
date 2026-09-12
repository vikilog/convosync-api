import assert from 'node:assert/strict';
import {
  billingLimitQuerySchema,
  billingMonthQuerySchema,
  cancelSubscriptionSchema,
  createOrderSchema,
  createSubscriptionSchema,
  refundSchema,
  updateWalletSchema,
  validateCouponSchema,
  verifyOrderSchema,
} from './billing.schemas.js';

assert.equal(billingLimitQuerySchema.safeParse({}).success, true);
assert.equal(billingLimitQuerySchema.safeParse({ limit: '10' }).success, true);
assert.equal(billingLimitQuerySchema.safeParse({ limit: 0 }).success, false);
assert.equal(billingMonthQuerySchema.safeParse({ month: '2026-09' }).success, true);
assert.equal(billingMonthQuerySchema.safeParse({ month: '09-2026' }).success, false);
assert.equal(updateWalletSchema.safeParse({}).success, true);
assert.equal(updateWalletSchema.safeParse({ lowBalanceThresholdPaise: 500 }).success, false);
assert.equal(createOrderSchema.safeParse({}).success, true);
assert.equal(createOrderSchema.safeParse({ purpose: 'nope' }).success, false);
assert.equal(
  verifyOrderSchema.safeParse({
    razorpay_order_id: 'o',
    razorpay_payment_id: 'p',
    razorpay_signature: 's',
  }).success,
  true
);
assert.equal(verifyOrderSchema.safeParse({}).success, false);
assert.equal(createSubscriptionSchema.safeParse({ planId: 'p1' }).success, true);
assert.equal(validateCouponSchema.safeParse({ code: 'SAVE', amountPaise: 100 }).success, true);
assert.equal(validateCouponSchema.safeParse({ code: 'SAVE' }).success, false);
assert.equal(cancelSubscriptionSchema.safeParse({}).success, true);
assert.equal(refundSchema.safeParse({ paymentId: 'pay_1' }).success, true);
assert.equal(refundSchema.safeParse({}).success, false);

console.log('billing.schemas.check.ts: ok');
