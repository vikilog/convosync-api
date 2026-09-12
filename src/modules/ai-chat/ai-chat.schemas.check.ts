import assert from 'node:assert/strict';
import { aiChatMessageSchema } from './ai-chat.schemas.js';

assert.equal(
  aiChatMessageSchema.safeParse({
    venueId: 'v1',
    message: 'hello',
    customerId: 'c1',
    channel: 'web',
  }).success,
  true
);
assert.equal(
  aiChatMessageSchema.safeParse({ venueId: 'v1', message: '', customerId: 'c1', channel: 'web' })
    .success,
  false
);
assert.equal(aiChatMessageSchema.safeParse({ message: 'hello' }).success, false);

console.log('ai-chat.schemas.check.ts: ok');
