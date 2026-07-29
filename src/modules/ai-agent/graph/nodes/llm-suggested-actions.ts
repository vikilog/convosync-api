/**
 * Fallback only — normally compose_answer folds suggestions into one LLM call.
 * Kept for paths that set suggestedActionsResolved=false.
 */
import { getLlmSuggestedActions } from '../../actions/llm-suggested-actions.js';
import type { AgentGraphStateType } from '../state.js';

export async function llmSuggestedActionsNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  if (state.suggestedActionsResolved) {
    return {};
  }

  const ruleActions = state.ruleActions || [];
  const hasTerminal = ruleActions.some(
    (a) => a.type === 'escalate_to_human' || a.type === 'close_conversations'
  );
  const intent = state.intent || 'unknown';
  const path = state.retrievalPath;

  if (
    hasTerminal ||
    intent === 'unknown' ||
    path === 'cache' ||
    path === 'direct' ||
    !state.reply?.trim()
  ) {
    return { llmActions: [], suggestedActionsResolved: true };
  }

  try {
    const llmActions = await getLlmSuggestedActions({
      message: state.message,
      reply: state.reply,
      llmClient: state.llm,
      workspaceId: state.workspaceId,
    });
    return {
      llmActions,
      suggestedActionsResolved: true,
      llmCallCount: (state.llmCallCount || 0) + 1,
    };
  } catch (err) {
    console.warn(
      '[agent-graph] llm_suggested_actions failed',
      err instanceof Error ? err.message : err
    );
    return { llmActions: [], suggestedActionsResolved: true };
  }
}
