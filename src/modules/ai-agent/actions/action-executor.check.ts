/**
 * Runnable self-check for action helpers (no DB).
 *   npx tsx src/modules/ai-agent/actions/action-executor.check.ts
 */
import assert from 'node:assert/strict';
import { getRuleBasedActions } from './rule-based-actions.js';

assert.deepEqual(
  getRuleBasedActions({ intent: 'human_request', retrievalPath: 'rag', message: 'hi' }),
  [{ type: 'escalate_to_human' }]
);
assert.deepEqual(
  getRuleBasedActions({ intent: 'general', retrievalPath: 'escalate', message: 'price?' }),
  [{ type: 'escalate_to_human' }]
);
assert.deepEqual(
  getRuleBasedActions({ intent: 'general', retrievalPath: 'rag', message: 'Thanks!' }),
  [{ type: 'close_conversations' }]
);
assert.deepEqual(
  getRuleBasedActions({ intent: 'general', retrievalPath: 'rag', message: 'what is pricing?' }),
  []
);

console.log('action-executor.check: ok');
