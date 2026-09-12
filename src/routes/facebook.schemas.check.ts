import assert from 'node:assert/strict';
import {
  facebookConnectBodySchema,
  facebookCreatePostBodySchema,
  facebookOauthCodeBodySchema,
  facebookPostParamsSchema,
} from './facebook.schemas.js';

assert.equal(facebookOauthCodeBodySchema.safeParse({ code: 'x' }).success, true);
assert.equal(facebookConnectBodySchema.safeParse({ pageId: '1', connectToken: 't' }).success, true);
assert.equal(facebookPostParamsSchema.safeParse({ postId: 'p' }).success, true);
assert.equal(facebookCreatePostBodySchema.safeParse({ message: 'hi' }).success, true);
assert.equal(facebookPostParamsSchema.safeParse({}).success, false);

console.log('facebook.schemas.check.ts: ok');
