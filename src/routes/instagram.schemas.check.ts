import assert from 'node:assert/strict';
import {
  instagramConnectBodySchema,
  instagramListeningListQuerySchema,
  instagramReplyBodySchema,
  instagramSyncBodySchema,
} from './instagram.schemas.js';

assert.equal(instagramConnectBodySchema.safeParse({ code: 'x' }).success, true);
assert.equal(instagramListeningListQuerySchema.safeParse({ limit: '10' }).success, true);
assert.equal(instagramReplyBodySchema.safeParse(undefined).success, true);
assert.equal(instagramSyncBodySchema.safeParse({ maxPages: 2, loadMore: true }).success, true);
assert.equal(instagramSyncBodySchema.safeParse({ maxPages: '2' }).success, false);

console.log('instagram.schemas.check.ts: ok');
