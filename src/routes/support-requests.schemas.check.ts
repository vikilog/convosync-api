import assert from 'node:assert/strict';
import { supportRequestCreateSchema } from './support-requests.schemas.js';

assert.equal(
  supportRequestCreateSchema.safeParse({
    name: 'Ada',
    email: 'ada@example.com',
    message: 'Need help',
  }).success,
  true
);
assert.equal(
  supportRequestCreateSchema.safeParse({ name: 'Ada', email: 'not-email', message: 'Need help' })
    .success,
  false
);
assert.equal(supportRequestCreateSchema.safeParse({ name: 'Ada', email: 'ada@example.com' }).success, false);

console.log('support-requests.schemas.check.ts: ok');
