import assert from 'node:assert/strict';

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
const LOW = 0.6;

assert.equal(decideRetrievalPath(0.9, HIGH, LOW, false), 'direct');
assert.equal(decideRetrievalPath(0.85, HIGH, LOW, false), 'direct');
assert.equal(decideRetrievalPath(0.7, HIGH, LOW, false), 'rag');
assert.equal(decideRetrievalPath(0.6, HIGH, LOW, false), 'rag');
assert.equal(decideRetrievalPath(0.59, HIGH, LOW, false), 'full_llm');
assert.equal(decideRetrievalPath(null, HIGH, LOW, false), 'full_llm');
assert.equal(decideRetrievalPath(0.1, HIGH, LOW, true), 'escalate');
assert.equal(decideRetrievalPath(0.7, HIGH, LOW, true), 'rag');

console.log('route-decision.check: ok');
