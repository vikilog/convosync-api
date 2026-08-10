/**
 * Run: npx tsx src/lib/whatsappStatusErrors.check.ts
 */
import assert from 'node:assert/strict';
import {
  mergeWhatsAppStatusMetadata,
  normalizeWhatsAppStatusErrors,
  whatsappStatusTimestampToIso,
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

assert.equal(whatsappStatusTimestampToIso('1710000000'), new Date(1710000000 * 1000).toISOString());

const merged = mergeWhatsAppStatusMetadata(
  { templateId: 'tmpl_1', variables: ['a'] },
  {
    status: 'failed',
    timestamp: '1710000000',
    recipient_id: '919999999999',
    errors: [{ code: 131026, title: 'Message undeliverable' }],
  }
);
assert.equal(merged.templateId, 'tmpl_1');
assert.deepEqual(merged.variables, ['a']);
assert.deepEqual(merged.whatsappStatusErrors, [
  { code: 131026, title: 'Message undeliverable' },
]);
assert.deepEqual(merged.whatsappDeliveryStatus, {
  status: 'failed',
  timestamp: '1710000000',
  recipientId: '919999999999',
});
assert.ok(Array.isArray(merged.events));
assert.equal((merged.events as { type: string }[])[0]!.type, 'failed');

const delivered = mergeWhatsAppStatusMetadata(
  { templateId: 'x', events: [{ type: 'sent', at: '2024-01-01T00:00:00.000Z' }] },
  { status: 'delivered', timestamp: '1710000060' }
);
assert.equal(delivered.templateId, 'x');
assert.equal((delivered.events as unknown[]).length, 2);
assert.equal((delivered.events as { type: string }[])[1]!.type, 'delivered');
assert.equal(
  (delivered.events as { at: string }[])[1]!.at,
  new Date(1710000060 * 1000).toISOString()
);

console.log('whatsappStatusErrors.check: ok');
