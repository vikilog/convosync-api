/**
 * Hybrid retrieval routing paths for AI Agent queries.
 *
 * Score thresholds (env default; per-agent override via escalationRules.similarityLowThreshold):
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
  // Inclusive low bar: score === threshold → RAG (not escalate).
  if (topScore == null || topScore < low) {
    return escalateOnLow ? 'escalate' : 'full_llm';
  }
  if (topScore >= high) return 'direct';
  return 'rag';
}

/**
 * Route after retrieval. Any usable KB chunks (vector or lexical) → answer path;
 * escalate only when there is nothing to ground on.
 */
export function decidePathAfterRetrieval(params: {
  source: 'pgvector' | 'database' | 'none';
  topScore: number | null;
  high: number;
  low: number;
  escalateOnLow: boolean;
  hitCount: number;
}): Exclude<RetrievalPath, 'cache'> {
  if (params.source === 'none' || params.hitCount === 0) {
    return params.escalateOnLow ? 'escalate' : 'full_llm';
  }
  // Lexical / floor-score hits are usable KB — always RAG (never escalate at === low).
  if (params.source === 'database') return 'rag';
  return decideRetrievalPath(params.topScore, params.high, params.low, params.escalateOnLow);
}
