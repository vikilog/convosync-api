/** Wraps actions/rule-based-actions.ts `getRuleBasedActions`. Sets escalate/handoff reply when needed. */
import { getRuleBasedActions } from '../../actions/rule-based-actions.js';
import { KB_ESCALATE_REPLY_HUMAN, KB_OUT_OF_SCOPE_REPLY } from '../../hybrid/kb-bound.js';
import type { AgentGraphStateType } from '../state.js';

export async function ruleBasedActionsNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  const intent = state.intent || 'unknown';
  const retrievalPath = state.retrievalPath || 'full_llm';
  const ruleActions = getRuleBasedActions({
    intent,
    retrievalPath,
    message: state.message,
  });

  const patch: Partial<AgentGraphStateType> = { ruleActions };

  if (!state.reply?.trim()) {
    if (intent === 'human_request') {
      patch.reply = `${KB_ESCALATE_REPLY_HUMAN} 🙏`;
      patch.retrievalPath = 'escalate';
      patch.suggestedActionsResolved = true;
      patch.llmActions = [];
    } else if (retrievalPath === 'escalate') {
      patch.reply = KB_OUT_OF_SCOPE_REPLY;
      patch.suggestedActionsResolved = true;
      patch.llmActions = [];
    }
  }

  return patch;
}
