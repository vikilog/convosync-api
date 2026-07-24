/**
 * Self-check: conversation handover event wiring.
 * Run: npx tsx backend/src/services/conversation-event.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAiAssigneeType } from '../types/conversation-event.js';

const dir = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(dir, '../prisma/schema.prisma'), 'utf8');
const routes = readFileSync(join(dir, '../routes/conversations.ts'), 'utf8');
const assignee = readFileSync(join(dir, 'conversation-assignee.service.ts'), 'utf8');
const aiAgent = readFileSync(join(dir, 'ai-agent-inbound.service.ts'), 'utf8');
const aiFaq = readFileSync(join(dir, 'ai-inbound.service.ts'), 'utf8');
const router = readFileSync(join(dir, 'conversation-inbound-router.service.ts'), 'utf8');

assert.match(schema, /model ConversationEvent/);
assert.match(schema, /events\s+ConversationEvent\[\]/);

assert.match(routes, /\/:id\/takeover/);
assert.match(routes, /\/:id\/release-to-ai/);
assert.match(routes, /HUMAN_TAKEOVER/);
assert.match(routes, /HUMAN_RELEASED_TO_AI/);
assert.match(routes, /reason:\s*'takeover'/);

assert.match(assignee, /AI_ASSIGNED/);
assert.match(assignee, /isAiAssigneeType/);

assert.match(aiAgent, /ensureAiHandlingStarted/);
assert.match(aiFaq, /ensureAiHandlingStarted/);

assert.match(router, /case 'user':/);
assert.match(router, /skip — assigned to human agent/);

assert.equal(isAiAssigneeType('ai'), true);
assert.equal(isAiAssigneeType('ai_agent'), true);
assert.equal(isAiAssigneeType('user'), false);

console.log('conversation-event.check.ts: ok');
