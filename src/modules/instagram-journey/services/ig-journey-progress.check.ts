/**
 * Runnable check: IG progress labels for Ask Question waiting state.
 * Run: npx tsx src/modules/instagram-journey/services/ig-journey-progress.check.ts
 */
import assert from 'node:assert/strict';

// Mirrors step-state rules for a waiting Ask Question that already logged success.
function stepState(opts: {
  nodeId: string;
  currentId: string | null;
  success: boolean;
  status: string;
  type: string;
}): 'done' | 'current' | 'pending' | 'failed' {
  const { nodeId, currentId, success, status, type } = opts;
  if (success && nodeId !== currentId) return 'done';
  if (nodeId === currentId) {
    if (status === 'waiting' && type === 'ASK_QUESTION') return 'current';
    if (status === 'running' || status === 'waiting') return 'current';
  }
  if (success) return 'done';
  return 'pending';
}

assert.equal(
  stepState({
    nodeId: 'q1',
    currentId: 'q1',
    success: true,
    status: 'waiting',
    type: 'ASK_QUESTION',
  }),
  'current'
);
assert.equal(
  stepState({
    nodeId: 't1',
    currentId: 'q1',
    success: true,
    status: 'waiting',
    type: 'TRIGGER',
  }),
  'done'
);

console.log('ig-journey-progress check ok');
