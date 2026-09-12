import assert from 'node:assert/strict';
import { createSchema, sendTestSchema, updateSchema } from './whatsappFlows.schemas.js';

assert.equal(
  createSchema.safeParse({
    name: 'Lead form',
    flowJson: { version: '7.0', screens: [{ id: 'WELCOME' }] },
  }).success,
  true
);
assert.equal(createSchema.safeParse({ name: 'Lead form' }).success, false);
assert.equal(updateSchema.safeParse({}).success, true);
assert.equal(sendTestSchema.safeParse({ phone: '12345' }).success, false);
assert.equal(sendTestSchema.safeParse({ phone: '919876543210' }).success, true);

console.log('whatsappFlows.schemas.check.ts: ok');
