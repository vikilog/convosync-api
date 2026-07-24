/**
 * Hybrid retrieval routing paths for AI Agent queries.
 *
 * Score thresholds (env-tunable):
 * - score >= HIGH (default 0.85) → `direct` — return KB answer, no LLM
 * - LOW <= score < HIGH (default 0.70) → `rag` — LLM with matched chunks
 * - score < LOW → `escalate` by default (AI_ESCALATE_ON_LOW_SCORE=false → full_llm, still KB-gated)
 * - Redis exact hit → `cache`
 */
export type RetrievalPath = 'cache' | 'direct' | 'rag' | 'full_llm' | 'escalate';

export type HybridHit = {
  knowledgeItemId: string;
  title: string;
  content: string;
  score: number;
};

export type HybridQueryInput = {
  workspaceId: string;
  agentId: string;
  message: string;
  intent: string;
  stage: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
};

export type HybridQueryResult = {
  reply: string;
  path: RetrievalPath;
  fromCache: boolean;
  /** Top vector similarity when searched; null on cache hit / vector skip. */
  topScore: number | null;
  /** True when response was written to Redis (score >= LOW). */
  cacheable: boolean;
  promptTokens: number;
  completionTokens: number;
  kbChunksLoaded: number;
  skillsLoaded: string[];
};

export function decideRetrievalPath(
  topScore: number | null,
  high: number,
  low: number,
  escalateOnLow: boolean
): Exclude<RetrievalPath, 'cache'> {
  if (topScore == null || topScore < low) {
    return escalateOnLow ? 'escalate' : 'full_llm';
  }
  if (topScore >= high) return 'direct';
  return 'rag';
}
