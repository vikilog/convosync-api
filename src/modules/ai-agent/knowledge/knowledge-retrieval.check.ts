/**
 * Self-check: pgvector failure must fall back to DB KB (not kill AI reply).
 * Run: npx tsx backend/src/modules/ai-agent/knowledge/knowledge-retrieval.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'knowledge-retrieval.ts'), 'utf8');

assert.match(src, /pgvector search failed, using DB fallback/);
assert.match(src, /source: 'pgvector'/);
assert.doesNotMatch(src, /source: 'pinecone'/);

console.log('knowledge-retrieval.check.ts: ok');
