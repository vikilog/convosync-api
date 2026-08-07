/**
 * Run: npx tsx src/services/whatsappCreditLine.check.ts
 */
import assert from 'node:assert/strict';
import {
  buildCreditSharingAndAttachUrl,
  normalizeWabaCurrency,
} from './whatsappCreditLine.js';

assert.equal(normalizeWabaCurrency('inr'), 'INR');
assert.equal(normalizeWabaCurrency('USD'), 'USD');
assert.throws(() => normalizeWabaCurrency('XYZ'), /Unsupported/);

const url = buildCreditSharingAndAttachUrl({
  creditLineId: '1972385232742146',
  wabaId: '102290129340398',
  wabaCurrency: 'inr',
});
assert.equal(
  url,
  'https://graph.facebook.com/v21.0/1972385232742146/whatsapp_credit_sharing_and_attach?waba_currency=INR&waba_id=102290129340398'
);

assert.throws(
  () =>
    buildCreditSharingAndAttachUrl({
      creditLineId: 'not-a-number',
      wabaId: '1',
      wabaCurrency: 'USD',
    }),
  /numeric/
);

assert.throws(
  () =>
    buildCreditSharingAndAttachUrl({
      creditLineId: '1',
      wabaId: 'abc',
      wabaCurrency: 'USD',
    }),
  /numeric/
);

console.log('whatsappCreditLine.check: ok');
