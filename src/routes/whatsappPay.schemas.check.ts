import assert from 'node:assert/strict';
import { createRequestSchema } from './whatsappPay.schemas.js';

assert.equal(
  createRequestSchema.safeParse({
    contactName: 'Ada',
    contactPhone: '9999999999',
    amountPaise: 100,
    description: 'Invoice',
  }).success,
  true
);
assert.equal(createRequestSchema.safeParse({}).success, false);
assert.equal(
  createRequestSchema.safeParse({
    contactName: 'Ada',
    contactPhone: '12',
    amountPaise: 100,
    description: 'Invoice',
  }).success,
  false
);

console.log('whatsappPay.schemas.check.ts: ok');
