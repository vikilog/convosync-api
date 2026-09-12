import assert from 'node:assert/strict';
import {
  teamChatMessageCreateSchema,
  teamChatMessagesQuerySchema,
} from './teamChat.schemas.js';

assert.equal(teamChatMessagesQuerySchema.safeParse({ peerUserId: 'u1' }).success, true);
assert.equal(teamChatMessagesQuerySchema.safeParse({}).success, false);
assert.equal(
  teamChatMessageCreateSchema.safeParse({ body: 'hi', recipientUserId: 'u2' }).success,
  true
);
assert.equal(teamChatMessageCreateSchema.safeParse({ body: '', recipientUserId: 'u2' }).success, false);

console.log('teamChat.schemas.check.ts: ok');
