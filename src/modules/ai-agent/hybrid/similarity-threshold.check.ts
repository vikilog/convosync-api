/**
 * Run: npx tsx backend/src/modules/ai-agent/hybrid/similarity-threshold.check.ts
 */
import assert from 'node:assert/strict';
import {
  parseSimilarityLowThreshold,
  similarityLowFromEscalationRules,
  withSimilarityLowThreshold,
} from './similarity-threshold.js';

assert.equal(parseSimilarityLowThreshold(0.7), 0.7);
assert.equal(parseSimilarityLowThreshold(0), 0);
assert.equal(parseSimilarityLowThreshold(1), null);
assert.equal(parseSimilarityLowThreshold(0.99), 0.99);
assert.equal(parseSimilarityLowThreshold(-0.1), null);
assert.equal(parseSimilarityLowThreshold(1.1), null);
assert.equal(parseSimilarityLowThreshold('0.7'), null);

assert.equal(
  similarityLowFromEscalationRules({ similarityLowThreshold: 0.65 }, 0.7),
  0.65
);
assert.equal(
  similarityLowFromEscalationRules({ similarityLowThreshold: 1 }, 0.7),
  0.7
);
assert.equal(similarityLowFromEscalationRules({}, 0.7), 0.7);
assert.equal(similarityLowFromEscalationRules(null, 0.7), 0.7);

const merged = withSimilarityLowThreshold({ other: 1 }, 0.8);
assert.equal(merged.similarityLowThreshold, 0.8);
assert.equal(merged.other, 1);
const cleared = withSimilarityLowThreshold(merged, null);
assert.equal('similarityLowThreshold' in cleared, false);
assert.equal(cleared.other, 1);

console.log('similarity-threshold.check.ts: ok');
