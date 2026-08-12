/**
 * Self-check: skill-scoped KB ids helper + retrieval accepts knowledgeItemIds.
 * Run: npx tsx backend/src/modules/ai-agent/knowledge/skill-kb-scope.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { knowledgeIdsFromMatchedSkills } from '../context-builder.service.js';

assert.equal(knowledgeIdsFromMatchedSkills([]), undefined);
assert.equal(knowledgeIdsFromMatchedSkills([{ knowledgeItemIds: [] }]), undefined);
assert.deepEqual(
  knowledgeIdsFromMatchedSkills([
    { knowledgeItemIds: ['a', 'b'] },
    { knowledgeItemIds: ['b', 'c'] },
    { knowledgeItemIds: null },
  ]),
  ['a', 'b', 'c']
);

const here = dirname(fileURLToPath(import.meta.url));
const retrieval = readFileSync(join(here, 'knowledge-retrieval.ts'), 'utf8');
assert.match(retrieval, /knowledgeItemIds\?:/);
const index = readFileSync(join(here, 'knowledge-index.service.ts'), 'utf8');
assert.match(index, /"knowledgeItemId" = ANY/);

console.log('skill-kb-scope.check.ts: ok');
