import assert from 'node:assert/strict';
import {
  whatsappBusinessProfileBodySchema,
  whatsappConnectBodySchema,
  whatsappPaymentModeBodySchema,
  whatsappPhoneParamsSchema,
} from './whatsapp.schemas.js';

assert.equal(whatsappConnectBodySchema.safeParse({ code: 'x' }).success, true);
assert.equal(whatsappConnectBodySchema.safeParse({}).success, true);
assert.equal(whatsappPhoneParamsSchema.safeParse({ phoneNumberId: '1' }).success, true);
assert.equal(whatsappBusinessProfileBodySchema.safeParse(undefined).success, true);
assert.equal(whatsappPaymentModeBodySchema.safeParse({ paymentMode: 'self_pay' }).success, true);

console.log('whatsapp.schemas.check.ts: ok');
