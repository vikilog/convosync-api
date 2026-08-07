/**
 * Run: npx tsx src/services/whatsappPaymentConfig.check.ts
 */
import assert from 'node:assert/strict';
import {
  billingCheckUnknownNote,
  buildMetaPaymentSetupUrl,
  extractMetaErrorCode,
  formatMetaBillingProbeError,
  isBillingProbePermissionError,
  parseHasOwnMetaPaymentMethod,
} from './whatsappPaymentConfig.parse.js';

assert.equal(parseHasOwnMetaPaymentMethod({ primaryFundingId: '1234567890' }), true);
assert.equal(parseHasOwnMetaPaymentMethod({ primaryFundingId: 9876543210 }), true);
assert.equal(parseHasOwnMetaPaymentMethod({ primaryFundingId: '' }), false);
assert.equal(parseHasOwnMetaPaymentMethod({ primaryFundingId: '   ' }), false);
assert.equal(parseHasOwnMetaPaymentMethod({ primaryFundingId: null }), false);
assert.equal(parseHasOwnMetaPaymentMethod({}), false);

assert.equal(
  formatMetaBillingProbeError(
    { error: { message: 'Invalid OAuth access token.', code: 190 } },
    'fallback'
  ),
  'Meta could not check billing payment method (#190): Invalid OAuth access token.'
);
assert.equal(formatMetaBillingProbeError({}, 'fallback'), 'fallback');
assert.equal(formatMetaBillingProbeError(null, 'fallback'), 'fallback');

assert.equal(
  extractMetaErrorCode({
    error: {
      message:
        'You do not have permission to perform this action. This action requires that the Business that owns this App is a Business Solution Partner for WhatsApp.',
      code: 10,
    },
  }),
  10
);
assert.equal(isBillingProbePermissionError(10), true);
assert.equal(isBillingProbePermissionError(3), true);
assert.equal(isBillingProbePermissionError(200), true);
assert.equal(isBillingProbePermissionError(190), false);
assert.equal(isBillingProbePermissionError(null), false);
assert.match(billingCheckUnknownNote(), /Solution Partner/);

assert.equal(
  buildMetaPaymentSetupUrl('102290129340398'),
  'https://business.facebook.com/billing_hub/payment_methods?business_id=102290129340398'
);
assert.equal(
  buildMetaPaymentSetupUrl(null),
  'https://business.facebook.com/billing_hub/payment_methods'
);
assert.equal(
  buildMetaPaymentSetupUrl('not-a-number'),
  'https://business.facebook.com/billing_hub/payment_methods'
);

console.log('whatsappPaymentConfig.check: ok');
