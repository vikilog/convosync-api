/** Wraps actions/action-executor.ts `executeActions`. Failures logged, never thrown. */
import { executeActions } from '../../actions/action-executor.js';
import type { AgentGraphStateType } from '../state.js';

export async function executeActionsNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  const all = [...(state.ruleActions || []), ...(state.llmActions || [])];
  if (!all.length || !state.contactId || !state.conversationId) {
    return { actionResults: [] };
  }

  // Preview / non-inbox: conversationId may be AgentChat id — only run when mediaConversationId maps to inbox
  const inboxId = state.mediaConversationId;
  if (!inboxId || state.channel === 'preview') {
    return { actionResults: [] };
  }

  try {
    const actionResults = await executeActions(all, {
      prisma: state.fastify.prisma,
      workspaceId: state.workspaceId,
      conversationId: inboxId,
      contactId: state.contactId,
      agentId: state.agentId,
      intent: state.intent || 'unknown',
      triggerReason: `Auto: ${state.intent || 'unknown'}`,
    });
    return { actionResults };
  } catch (err) {
    console.error(
      '[agent-graph] execute_actions failed',
      err instanceof Error ? err.message : err
    );
    return { actionResults: [] };
  }
}
