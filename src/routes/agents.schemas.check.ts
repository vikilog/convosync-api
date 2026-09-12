import assert from 'node:assert/strict';
import {
  agentCreateSchema,
  agentChatSchema,
  knowledgeCreateSchema,
  profileUpdateSchema,
  skillCreateSchema,
  voicePreviewTtsSchema,
} from './agents.schemas.js';

assert.equal(agentCreateSchema.safeParse({ name: 'Support' }).success, true);
assert.equal(agentCreateSchema.safeParse({ name: '' }).success, false);
assert.equal(profileUpdateSchema.safeParse({}).success, true);
assert.equal(profileUpdateSchema.safeParse({ conversationCloseWaitMins: 0 }).success, false);
assert.equal(skillCreateSchema.safeParse({ title: 'FAQ' }).success, true);
assert.equal(agentChatSchema.safeParse({ message: 'hi' }).success, true);
assert.equal(agentChatSchema.safeParse({ message: '' }).success, false);
assert.equal(
  knowledgeCreateSchema.safeParse({ type: 'qna', title: 'Hours' }).success,
  true
);
assert.equal(voicePreviewTtsSchema.safeParse({}).success, true);

console.log('agents.schemas.check.ts: ok');
