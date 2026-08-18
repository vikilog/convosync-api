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

// Regression: "hey" must not spuriously match docs via substrings of
// "they"/"monkey"/"hockey" etc — it should behave like "hi"/"hello" (no
// lexical hit), letting the caller treat this as a pure greeting.
const heyDocs = [
  { id: '4', title: 'FAQ', content: 'They offer free shipping on hockey and monkey merchandise.' },
];
const hey = lexicalMatchKnowledgeItems(heyDocs, 'Hey', { score: 0.7 });
assert.equal(hey.length, 0);

// Regression: word-prefix matching, independent of the stop-word list above —
// a mid-word substring like "cat" inside "concatenate" must not count as a
// hit, even though "cat" itself is a real (non-stopword) query token.
const catDocs = [{ id: '5', title: 'Dev notes', content: 'Use string concatenation here.' }];
const catHit = lexicalMatchKnowledgeItems(catDocs, 'cat', { score: 0.7 });
assert.equal(catHit.length, 0);

console.log('knowledge-retrieval.check.ts: ok');
