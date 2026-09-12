import assert from 'node:assert/strict';
import { emailUnsubscribeQuerySchema } from './emailUnsubscribe.schemas.js';

assert.equal(emailUnsubscribeQuerySchema.safeParse({}).success, true);
assert.equal(emailUnsubscribeQuerySchema.safeParse({ t: 'tok' }).success, true);
assert.equal(emailUnsubscribeQuerySchema.safeParse({ t: 1 }).success, false);

console.log('emailUnsubscribe.schemas.check.ts: ok');
