import assert from 'node:assert/strict';
import { normalizeRandomizerPaths, pickWeightedEdge } from './randomizer.service.js';
import { typingDelayMs } from './typing-indicator.service.js';

const paths = normalizeRandomizerPaths([
  { id: 'a', weight: 70 },
  { id: 'b', weight: 30 },
]);
const edges = [
  { conditionValue: 'a', targetNodeId: 'ta' },
  { conditionValue: 'b', targetNodeId: 'tb' },
];

assert.equal(pickWeightedEdge(edges, paths, () => 0)?.targetNodeId, 'ta');
assert.equal(pickWeightedEdge(edges, paths, () => 0.69)?.targetNodeId, 'ta');
assert.equal(pickWeightedEdge(edges, paths, () => 0.71)?.targetNodeId, 'tb');

assert.ok(typingDelayMs('hi') >= 600);
assert.ok(typingDelayMs('x'.repeat(500)) <= 5000);

console.log('randomizer.service.check: ok');
