/**
 * Run: npx tsx src/utils/razorpay-error.utils.check.ts
 */
import assert from 'node:assert/strict';
import {
  extractRazorpayErrorDetails,
  normalizeRazorpayError,
} from './razorpay-error.utils.ts';

const sdkErr = Object.assign(new Error('Validation failed'), {
  statusCode: 400,
  error: {
    code: 'BAD_REQUEST_ERROR',
    description: 'Validation failed',
    field: 'customer_notify',
    reason: 'input_validation_failed',
    source: 'business',
    step: 'payment_initiation',
  },
});

const details = extractRazorpayErrorDetails(sdkErr);
assert.equal(details.description, 'Validation failed');
assert.equal(details.field, 'customer_notify');
assert.equal(details.source, 'business');
assert.equal(details.step, 'payment_initiation');
assert.deepEqual(details.rawError, sdkErr.error);

const msg = normalizeRazorpayError(sdkErr).message;
assert.match(msg, /Validation failed/);
assert.match(msg, /field=customer_notify/);
assert.match(msg, /source=business/);
assert.match(msg, /BAD_REQUEST_ERROR/);

// Opaque account-level reject (no field) — same shape Razorpay returns without start_at
const opaque = {
  statusCode: 400,
  error: { code: 'BAD_REQUEST_ERROR', description: 'Validation failed' },
};
assert.equal(
  extractRazorpayErrorDetails(opaque).message,
  'Validation failed (BAD_REQUEST_ERROR)'
);

// Re-normalize already-normalized Error keeps message
const once = normalizeRazorpayError(opaque);
assert.equal(normalizeRazorpayError(once).message, once.message);

console.log('normalizeRazorpayError check ok');
