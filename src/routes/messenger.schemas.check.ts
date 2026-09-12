import assert from 'node:assert/strict';
import {
  messengerConnectBodySchema,
  messengerDisconnectBodySchema,
  messengerSyncBodySchema,
} from './messenger.schemas.js';

assert.equal(messengerConnectBodySchema.safeParse(undefined).success, true);
assert.equal(messengerConnectBodySchema.safeParse({ pageId: '1' }).success, true);
assert.equal(messengerDisconnectBodySchema.safeParse({}).success, true);
assert.equal(messengerSyncBodySchema.safeParse({ maxPages: 2 }).success, true);
assert.equal(messengerSyncBodySchema.safeParse({ maxPages: '2' }).success, false);

console.log('messenger.schemas.check.ts: ok');
