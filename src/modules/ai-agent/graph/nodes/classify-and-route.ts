/**
 * Wraps intent.service.ts `classifyIntent` + conversational path shortcuts.
 * Vector score routing happens in retrieve_kb (needs embeddings).
 */
import { classifyIntent, INTENTS } from '../../intent.service.js';
import { isConversationalTurn } from '../../hybrid/kb-bound.js';
import type { AgentGraphStateType } from '../state.js';

export async function classifyAndRouteNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  const recentContext = state.history
    .slice(-2)
    .map((m) => m.content)
    .join(' ');

  const { intent, tokensUsed } = await classifyIntent(state.llm, state.message, recentContext);

  let retrievalPath = state.retrievalPath;
  if (intent === INTENTS.HUMAN_REQUEST) {
    retrievalPath = 'escalate';
  } else if (isConversationalTurn(intent, state.stage, state.message)) {
    retrievalPath = 'full_llm';
  }

  return {
    intent,
    retrievalPath,
    promptTokens: (state.promptTokens || 0) + tokensUsed,
    completionTokens: state.completionTokens || 0,
    llmCallCount: (state.llmCallCount || 0) + 1,
  };
}
