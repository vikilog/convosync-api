/** Wraps hybrid/redis-cache.ts `checkRedisCache`. */
import { KB_OUT_OF_SCOPE_REPLY } from '../../hybrid/kb-bound.js';
import { checkRedisCache } from '../../hybrid/redis-cache.js';
import type { AgentGraphStateType } from '../state.js';

export async function checkCacheNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  const cached = await checkRedisCache(state.fastify, {
    workspaceId: state.workspaceId,
    agentId: state.agentId,
    question: state.message,
  });
  // Stale escalate/OOS must not short-circuit retrieval after path fixes.
  if (!cached?.trim() || cached.trim() === KB_OUT_OF_SCOPE_REPLY) {
    return { fromCache: false };
  }
  return {
    reply: cached,
    fromCache: true,
    retrievalPath: 'cache',
    intent: state.intent || 'unknown',
    promptTokens: 0,
    completionTokens: 0,
    kbChunksLoaded: 0,
    skillsLoaded: [],
  };
}
