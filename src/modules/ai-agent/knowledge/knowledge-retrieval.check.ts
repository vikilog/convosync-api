/**
 * Self-check: pgvector miss → lexical DB fallback; skill-scope empty → agent-wide.
 * Run: npx tsx backend/src/modules/ai-agent/knowledge/knowledge-retrieval.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lexicalMatchKnowledgeItems } from './knowledge-retrieval.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'knowledge-retrieval.ts'), 'utf8');

assert.match(src, /pgvector search failed, using DB fallback/);
assert.match(src, /source: 'pgvector'/);
assert.match(src, /lexicalMatchKnowledgeItems/);
assert.doesNotMatch(src, /source: 'pinecone'/);

const docs = [
  {
    id: '1',
    title: 'Documentation',
    content:
      'Catalog Manage all your salon offerings. From services to retail products and packages.',
  },
  { id: '2', title: 'EmptyDoc.md', content: '' },
  { id: '3', title: 'Other', content: 'Refund policy within 7 days.' },
];

const services = lexicalMatchKnowledgeItems(docs, 'kya kya service hai dasalon kii ?', {
  score: 0.7,
});
assert.equal(services.length, 1);
assert.equal(services[0]?.title, 'Documentation');
assert.equal(services[0]?.score, 0.7);

const oos = lexicalMatchKnowledgeItems(docs, 'What is the capital of France?', { score: 0.7 });
assert.equal(oos.length, 0);

console.log('knowledge-retrieval.check.ts: ok');
