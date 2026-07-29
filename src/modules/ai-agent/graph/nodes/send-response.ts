/**
 * Finalizes the turn reply. WhatsApp Meta send stays in ai-agent-inbound.service.ts
 * (sendWhatsAppMessage / sendAgentMediaAsset) so chat()/preview keep the same return contract.
 * Optional outbound hook: when `outbound` is present on state in future, call those senders here.
 */
import { setRedisCache } from '../../hybrid/redis-cache.js';
import { config } from '../../../../config.js';
import type { AgentGraphStateType } from '../state.js';

export async function sendResponseNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  const reply = state.reply?.trim() || 'Sorry, kuch galat hua. Please dobara try karein.';

  // Cache high-confidence non-escalate answers (same policy as hybrid orchestrator).
  if (
    !state.fromCache &&
    reply &&
    state.retrievalPath &&
    state.retrievalPath !== 'escalate' &&
    (state.topScore == null || state.topScore >= config.ai.similarityLowThreshold)
  ) {
    await setRedisCache(state.fastify, {
      workspaceId: state.workspaceId,
      agentId: state.agentId,
      question: state.message,
      answer: reply,
    });
  }

  return {
    reply,
    mediaAttachment: state.mediaAttachment || { action: 'none' },
  };
}
