import assert from 'node:assert/strict';
import { formatPaymentAmount, paymentLabelFromInvoice } from './paymentNotify.js';
import { forBellForType, NOTIFICATION_TYPES, severityForType } from './types.js';

assert.equal(formatPaymentAmount(99900, 'INR'), '₹999');
assert.equal(formatPaymentAmount(200, 'USD'), '$2.00');
assert.equal(paymentLabelFromInvoice({ type: 'wallet_topup' }), 'Wallet top-up');
assert.equal(
  paymentLabelFromInvoice({
    type: 'plan_purchase',
    metadata: { planName: 'Growth' },
  }),
  'Growth'
);
assert.equal(forBellForType(NOTIFICATION_TYPES.PAYMENT_SUCCESS), true);
assert.equal(forBellForType(NOTIFICATION_TYPES.PAYMENT_FAILED), true);
assert.equal(severityForType(NOTIFICATION_TYPES.PAYMENT_SUCCESS), 'success');
assert.equal(severityForType(NOTIFICATION_TYPES.PAYMENT_FAILED), 'failure');

console.log('paymentNotify.check.ts: ok');
