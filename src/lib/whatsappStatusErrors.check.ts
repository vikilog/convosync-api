/**
 * Run: npx tsx src/lib/whatsappStatusErrors.check.ts
 */
import assert from 'node:assert/strict';
import {
  mergeWhatsAppStatusMetadata,
  normalizeWhatsAppStatusErrors,
} from './whatsappStatusErrors.js';

const normalized = normalizeWhatsAppStatusErrors([
  {
    code: 131026,
    title: 'Message undeliverable',
    message: 'Message undeliverable',
    href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
    error_data: { details: 'Message Undeliverable.' },
    noise: true,
  },
  null,
  'skip',
  { title: 'only title' },
]);
assert.equal(normalized.length, 2);
assert.deepEqual(normalized[0], {
  code: 131026,
  title: 'Message undeliverable',
  message: 'Message undeliverable',
  href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
  error_data: { details: 'Message Undeliverable.' },
});
assert.deepEqual(normalized[1], { title: 'only title' });
assert.deepEqual(normalizeWhatsAppStatusErrors(undefined), []);
assert.deepEqual(normalizeWhatsAppStatusErrors({ code: 1 }), []);

const merged = mergeWhatsAppStatusMetadata(
  { templateId: 'tmpl_1', variables: ['a'] },
  {
    status: 'failed',
    timestamp: '1710000000',
    recipient_id: '919999999999',
    errors: [{ code: 131026, title: 'Message undeliverable' }],
  }
);
assert.ok(merged);
assert.equal(merged!.templateId, 'tmpl_1');
assert.deepEqual(merged!.variables, ['a']);
assert.deepEqual(merged!.whatsappStatusErrors, [
  { code: 131026, title: 'Message undeliverable' },
]);
assert.deepEqual(merged!.whatsappDeliveryStatus, {
  status: 'failed',
  timestamp: '1710000000',
  recipientId: '919999999999',
});

assert.equal(
  mergeWhatsAppStatusMetadata({ templateId: 'x' }, { status: 'delivered' }),
  null
);

console.log('whatsappStatusErrors.check: ok');
