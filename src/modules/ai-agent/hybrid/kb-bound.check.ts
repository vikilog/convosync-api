import assert from 'node:assert/strict';
import {
  KB_NO_MATCH_SYSTEM_PREFIX,
  KB_OUT_OF_SCOPE_REPLY,
  buildKbOutOfScopeEscalation,
  filterHitsByMinScore,
  guardKbBoundReply,
  isConversationalTurn,
  isReplyGroundedInKb,
} from './kb-bound.js';

/** Mirrors hybrid/types.ts decideRetrievalPath — keep in sync. */
function decideRetrievalPath(
  topScore: number | null,
  high: number,
  low: number,
  escalateOnLow: boolean
): 'direct' | 'rag' | 'full_llm' | 'escalate' {
  if (topScore == null || topScore < low) {
    return escalateOnLow ? 'escalate' : 'full_llm';
  }
  if (topScore >= high) return 'direct';
  return 'rag';
}

const HIGH = 0.85;
const LOW = 0.7;

assert.equal(decideRetrievalPath(0.9, HIGH, LOW, true), 'direct');
assert.equal(decideRetrievalPath(0.75, HIGH, LOW, true), 'rag');
assert.equal(decideRetrievalPath(0.7, HIGH, LOW, true), 'rag');
assert.equal(decideRetrievalPath(0.69, HIGH, LOW, true), 'escalate');
assert.equal(decideRetrievalPath(null, HIGH, LOW, true), 'escalate');
assert.equal(decideRetrievalPath(0.1, HIGH, LOW, false), 'full_llm');

const hits = [
  { id: 'a', score: 0.82, content: 'Refund within 7 days' },
  { id: 'b', score: 0.55, content: 'Unrelated weak hit' },
  { id: 'c', score: 0.71, content: 'Shipping takes 3 days' },
];
const confident = filterHitsByMinScore(hits, LOW);
assert.equal(confident.length, 2);
assert.deepEqual(
  confident.map((h) => h.id),
  ['a', 'c']
);
assert.equal(filterHitsByMinScore(hits, 0.9).length, 0);

assert.equal(isConversationalTurn('greeting', 'intent_identified'), true);
assert.equal(isConversationalTurn('general', 'greeting'), true);
assert.equal(isConversationalTurn('general', 'intent_identified'), false);

assert.equal(buildKbOutOfScopeEscalation('no_kb_match').escalate, true);
assert.equal(buildKbOutOfScopeEscalation('off_topic').reply, KB_OUT_OF_SCOPE_REPLY);
assert.ok(KB_NO_MATCH_SYSTEM_PREFIX.startsWith('PRIORITY'));
assert.ok(KB_NO_MATCH_SYSTEM_PREFIX.includes('Do not answer from general/training knowledge'));

const kb =
  'Our refund policy allows returns within 7 days of purchase. Shipping takes 3–5 business days.';

assert.equal(
  isReplyGroundedInKb('You can get a refund within 7 days of purchase.', kb),
  true
);
assert.equal(
  isReplyGroundedInKb(
    'The capital of France is Paris and Einstein invented relativity in 1905.',
    kb
  ),
  false
);
assert.equal(isReplyGroundedInKb('Some invented pricing is $9999/month forever.', ''), false);

const replaced = guardKbBoundReply({
  reply: 'Competitors like Acme charge half price and also cure cancer.',
  kbText: kb,
});
assert.equal(replaced.replaced, true);
assert.equal(replaced.escalate, true);
assert.equal(replaced.reply, KB_OUT_OF_SCOPE_REPLY);

const ok = guardKbBoundReply({
  reply: 'Refunds are available within 7 days.',
  kbText: kb,
});
assert.equal(ok.replaced, false);

/** Out-of-scope queries: simulate low/no retrieval → must escalate, never invent. */
const OUT_OF_SCOPE_QUERIES = [
  'What is the capital of France?',
  'Who won the Cricket World Cup in 2011?',
  'Write me a Python bubble sort',
  'What is Intercom pricing vs ours?',
  'How do I treat a fever at home?',
  'Tell me a joke about politicians',
  'What is the weather in Mumbai today?',
  'Explain quantum entanglement simply',
  'Is Bitcoin going to crash next week?',
  'Who is the CEO of Google?',
];

for (const q of OUT_OF_SCOPE_QUERIES) {
  // Simulated retrieval: unrelated/low score (common for OOS questions)
  const fakeTop = 0.42;
  const path = decideRetrievalPath(fakeTop, HIGH, LOW, true);
  assert.equal(path, 'escalate', `expected escalate for: ${q}`);

  const emptyKbGuard = guardKbBoundReply({
    reply: `Sure! Here's a detailed answer about "${q}" from my training data...`,
    kbText: '',
  });
  assert.equal(emptyKbGuard.replaced, true, `guard must replace training answer for: ${q}`);
  assert.equal(emptyKbGuard.reply, KB_OUT_OF_SCOPE_REPLY);
}

console.log(`kb-bound.check: ok (${OUT_OF_SCOPE_QUERIES.length} out-of-scope cases)`);
