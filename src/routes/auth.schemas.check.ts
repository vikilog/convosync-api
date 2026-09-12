import assert from 'node:assert/strict';
import { loginBodySchema, registerBodySchema } from './auth.schemas.js';

assert.equal(loginBodySchema.safeParse({}).success, false);
assert.equal(loginBodySchema.safeParse({ email: 'not-an-email', password: 'x' }).success, false);
assert.equal(loginBodySchema.safeParse({ email: 'a@b.co', password: 'x' }).success, true);

assert.equal(registerBodySchema.safeParse({ name: 'Jo', email: 'a@b.co', password: 'short' }).success, false);
assert.equal(
  registerBodySchema.safeParse({ name: 'Jo', email: 'a@b.co', password: '12345678' }).success,
  true
);

console.log('auth.schemas.check.ts: ok');
