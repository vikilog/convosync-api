import assert from 'node:assert/strict';
import { analyticsMessagesQuerySchema } from './analytics.schemas.js';

assert.equal(analyticsMessagesQuerySchema.safeParse({}).success, true);
assert.equal(analyticsMessagesQuerySchema.safeParse({ days: '7' }).success, true);
assert.equal(analyticsMessagesQuerySchema.safeParse({ days: 7 }).success, false);

console.log('analytics.schemas.check.ts: ok');
