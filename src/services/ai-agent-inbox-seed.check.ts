/**
 * Self-check: inbox → agent chat history seed.
 * Run: npx tsx backend/src/services/ai-agent-inbox-seed.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const seed = readFileSync(join(dir, 'ai-agent-inbox-seed.service.ts'), 'utf8');
const inbound = readFileSync(join(dir, 'ai-agent-inbound.service.ts'), 'utf8');
const assignee = readFileSync(join(dir, 'conversation-assignee.service.ts'), 'utf8');

assert.match(seed, /seedAgentChatFromInbox/);
assert.match(seed, /inbox_seed/);
assert.match(seed, /excludeContactText/);
assert.match(inbound, /kickAiAgentReplyForLatestContactMessage/);
assert.match(assignee, /kickAiAgentReplyForLatestContactMessage/);
assert.match(inbound, /seedAgentChatFromInbox/);
assert.match(assignee, /seedAgentChatFromInbox/);

console.log('ai-agent-inbox-seed.check.ts: ok');
