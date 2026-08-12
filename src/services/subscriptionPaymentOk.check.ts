/**
 * Run: npx tsx src/services/subscriptionPaymentOk.check.ts
 */
import assert from 'node:assert/strict';
import {
  matchSubscriptionIdByCheckoutDescription,
  subscriptionCheckoutPaymentOk,
} from './subscriptionPaymentOk.ts';

assert.equal(
  subscriptionCheckoutPaymentOk({ paymentStatus: 'captured', subscriptionStatus: 'active' }),
  true
);
assert.equal(
  subscriptionCheckoutPaymentOk({ paymentStatus: 'authorized', subscriptionStatus: 'authenticated' }),
  true
);
assert.equal(
  subscriptionCheckoutPaymentOk({ paymentStatus: 'refunded', subscriptionStatus: 'authenticated' }),
  true
);
assert.equal(
  subscriptionCheckoutPaymentOk({ paymentStatus: 'refunded', subscriptionStatus: 'active' }),
  true
);
assert.equal(
  subscriptionCheckoutPaymentOk({ paymentStatus: 'refunded', subscriptionStatus: 'created' }),
  false
);
assert.equal(
  subscriptionCheckoutPaymentOk({ paymentStatus: 'failed', subscriptionStatus: 'authenticated' }),
  false
);

assert.equal(
  matchSubscriptionIdByCheckoutDescription('Business (monthly)', [
    {
      planName: 'Business',
      billingCycle: 'monthly',
      razorpaySubscriptionId: 'sub_abc',
    },
  ]),
  'sub_abc'
);
assert.equal(
  matchSubscriptionIdByCheckoutDescription('Business (monthly)', [
    {
      planName: 'Starter',
      billingCycle: 'monthly',
      razorpaySubscriptionId: 'sub_nope',
    },
  ]),
  null
);

console.log('subscriptionPaymentOk.check ok');
