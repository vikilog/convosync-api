import type { AiAgentKnowledgeItem } from '@prisma/client';
import { config } from '../../../config.js';
import { filterHitsByMinScore } from '../hybrid/kb-bound.js';
import { knowledgeIndexService, type KnowledgeSearchHit } from './knowledge-index.service.js';

export type RetrievedKnowledgeChunk = {
  title: string;
  content: string | null;
  score?: number;
};

function fallbackChunks(
  items: Pick<AiAgentKnowledgeItem, 'title' | 'content'>[],
  limit = 3
): RetrievedKnowledgeChunk[] {
  return items.slice(0, limit).map((item) => ({
    title: item.title,
    content: item.content,
  }));
}

/**
 * Retrieve KB chunks for LLM context.
 * Hits below SIMILARITY_LOW_THRESHOLD are dropped (no inject).
 * By default there is no naive DB fill — empty means "no confident match".
 */
export async function retrieveKnowledgeChunks(params: {
  workspaceId: string;
  agentId: string;
  query: string;
  fallbackItems: Pick<AiAgentKnowledgeItem, 'title' | 'content'>[];
  topK?: number;
  /** Only for offline/preview tooling — never for live agent answers. */
  allowUnscoredDbFallback?: boolean;
  minScore?: number;
}): Promise<{ chunks: RetrievedKnowledgeChunk[]; source: 'pgvector' | 'database' | 'none' }> {
  const minScore = params.minScore ?? config.ai.similarityLowThreshold;

  if (knowledgeIndexService.isEnabled() && params.query.trim()) {
    try {
      const hits: KnowledgeSearchHit[] = await knowledgeIndexService.search({
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        query: params.query,
        topK: params.topK,
      });

      const confident = filterHitsByMinScore(hits, minScore);
      if (confident.length > 0) {
        return {
          source: 'pgvector',
          chunks: confident.map((hit) => ({
            title: hit.title,
            content: hit.content,
            score: hit.score,
          })),
        };
      }

      // Low / no match: do not pass weak or unrelated KB to the LLM.
      return { source: 'none', chunks: [] };
    } catch (err) {
      console.warn(
        '[KnowledgeRetrieval] pgvector search failed',
        err instanceof Error ? err.message : err
      );
      if (!params.allowUnscoredDbFallback) {
        return { source: 'none', chunks: [] };
      }
    }
  }

  if (params.allowUnscoredDbFallback) {
    return {
      source: 'database',
      chunks: fallbackChunks(params.fallbackItems),
    };
  }

  return { source: 'none', chunks: [] };
}
