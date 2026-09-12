import assert from 'node:assert/strict';
import {
  igBusinessConnectBodySchema,
  igBusinessDeleteBodySchema,
  igBusinessHideBodySchema,
  igBusinessReplyBodySchema,
} from './instagramBusinessLogin.schemas.js';

assert.equal(igBusinessConnectBodySchema.safeParse({ code: 'x' }).success, true);
assert.equal(igBusinessConnectBodySchema.safeParse({}).success, true);
assert.equal(igBusinessReplyBodySchema.safeParse({ message: 'hi' }).success, true);
assert.equal(igBusinessHideBodySchema.safeParse({ hidden: true }).success, true);
assert.equal(igBusinessDeleteBodySchema.safeParse(undefined).success, true);

console.log('instagramBusinessLogin.schemas.check.ts: ok');
