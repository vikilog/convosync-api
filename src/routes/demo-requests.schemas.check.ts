import assert from 'node:assert/strict';
import { demoRequestCreateSchema } from './demo-requests.schemas.js';

assert.equal(
  demoRequestCreateSchema.safeParse({ name: 'Ada', email: 'ada@example.com' }).success,
  true
);
assert.equal(demoRequestCreateSchema.safeParse({ name: 'Ada', email: 'not-email' }).success, false);
assert.equal(demoRequestCreateSchema.safeParse({ email: 'ada@example.com' }).success, false);

console.log('demo-requests.schemas.check.ts: ok');
