import type { AiAgentKnowledgeItem } from '@prisma/client';
import { config } from '../../../config.js';
import { filterHitsByMinScore } from '../hybrid/kb-bound.js';
import { knowledgeIndexService, type KnowledgeSearchHit } from './knowledge-index.service.js';

export type RetrievedKnowledgeChunk = {
  knowledgeItemId?: string;
  title: string;
  content: string | null;
  score?: number;
};

const LEXICAL_STOP = new Set(
  'a an the is are was were be been being to of in on for with and or but if then so it this that these those i you we they he she my your our their me us him her what which who how when where why can could should would will just please hi hello thanks thank ok yeah yes no not hai hun hu kya ke ki ka ko se me mein kii'.split(
    ' '
  )
);

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !LEXICAL_STOP.has(t));
}

/**
 * Keyword overlap fallback when embeddings score below threshold
 * (common for Hinglish queries against English KB).
 * Returns [] when no token overlap — caller should escalate, not invent.
 */
export function lexicalMatchKnowledgeItems(
  items: Pick<AiAgentKnowledgeItem, 'id' | 'title' | 'content'>[],
  query: string,
  opts?: { limit?: number; score?: number }
): RetrievedKnowledgeChunk[] {
  const limit = opts?.limit ?? 3;
  const score = opts?.score ?? config.ai.similarityLowThreshold;
  const tokens = queryTokens(query);
  if (tokens.length === 0 || items.length === 0) return [];

  const ranked = items
    .map((item) => {
      const body = (item.content ?? '').trim();
      if (!body) return { item, hits: 0 };
      const hay = `${item.title}\n${body}`.toLowerCase();
      let hits = 0;
      for (const t of tokens) {
        if (hay.includes(t)) hits += 1;
      }
      return { item, hits };
    })
    .filter((r) => r.hits > 0)
    .sort(
      (a, b) =>
        b.hits - a.hits || (b.item.content?.length ?? 0) - (a.item.content?.length ?? 0)
    );

  return ranked.slice(0, limit).map((r) => ({
    knowledgeItemId: r.item.id,
    title: r.item.title,
    content: r.item.content,
    // Floor score at the inclusive low bar so path stays RAG (not escalate-at-threshold).
    score,
  }));
}

function fallbackChunks(
  items: Pick<AiAgentKnowledgeItem, 'id' | 'title' | 'content'>[],
  limit = 3,
  score?: number
): RetrievedKnowledgeChunk[] {
  return items.slice(0, limit).map((item) => ({
    knowledgeItemId: item.id,
    title: item.title,
    content: item.content,
    score,
  }));
}

async function vectorSearch(params: {
  workspaceId: string;
  agentId: string;
  query: string;
  topK?: number;
  knowledgeItemIds?: string[];
  minScore: number;
}): Promise<KnowledgeSearchHit[]> {
  const hits = await knowledgeIndexService.search({
    workspaceId: params.workspaceId,
    agentId: params.agentId,
    query: params.query,
    topK: params.topK,
    knowledgeItemIds: params.knowledgeItemIds,
  });
  return filterHitsByMinScore(hits, params.minScore);
}

/**
 * Retrieve KB chunks for LLM context.
 * 1) pgvector (skill-scoped, then agent-wide if scoped empty)
 * 2) lexical DB overlap when vectors miss but docs exist
 * Empty means no confident/lexical match → escalate.
 */
export async function retrieveKnowledgeChunks(params: {
  workspaceId: string;
  agentId: string;
  query: string;
  fallbackItems: Pick<AiAgentKnowledgeItem, 'id' | 'title' | 'content'>[];
  topK?: number;
  /** Naive first-N DB fill when embeddings unavailable (preview/offline). */
  allowUnscoredDbFallback?: boolean;
  minScore?: number;
  /** When set (non-empty), prefer these item IDs; fall back agent-wide if empty. */
  knowledgeItemIds?: string[];
}): Promise<{ chunks: RetrievedKnowledgeChunk[]; source: 'pgvector' | 'database' | 'none' }> {
  const minScore = params.minScore ?? config.ai.similarityLowThreshold;
  const scopedIds = params.knowledgeItemIds?.filter(Boolean) ?? [];
  const scopedPool =
    scopedIds.length > 0
      ? params.fallbackItems.filter((item) => scopedIds.includes(item.id))
      : params.fallbackItems;
  // Stale/empty skill links must not zero out agent KB.
  const pool = scopedPool.length > 0 ? scopedPool : params.fallbackItems;

  if (knowledgeIndexService.isEnabled() && params.query.trim()) {
    try {
      let confident = await vectorSearch({
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        query: params.query,
        topK: params.topK,
        knowledgeItemIds: scopedIds.length > 0 ? scopedIds : undefined,
        minScore,
      });

      if (confident.length === 0 && scopedIds.length > 0) {
        confident = await vectorSearch({
          workspaceId: params.workspaceId,
          agentId: params.agentId,
          query: params.query,
          topK: params.topK,
          minScore,
        });
      }

      if (confident.length > 0) {
        return {
          source: 'pgvector',
          chunks: confident.map((hit) => ({
            knowledgeItemId: hit.knowledgeItemId,
            title: hit.title,
            content: hit.content,
            score: hit.score,
          })),
        };
      }

      const lexical = lexicalMatchKnowledgeItems(pool, params.query, {
        limit: params.topK ?? 3,
        score: minScore,
      });
      if (lexical.length > 0) {
        return { source: 'database', chunks: lexical };
      }

      // Scoped pool had docs but no token overlap → try agent-wide once.
      if (pool !== params.fallbackItems && params.fallbackItems.length > 0) {
        const wide = lexicalMatchKnowledgeItems(params.fallbackItems, params.query, {
          limit: params.topK ?? 3,
          score: minScore,
        });
        if (wide.length > 0) {
          return { source: 'database', chunks: wide };
        }
      }

      return { source: 'none', chunks: [] };
    } catch (err) {
      console.warn(
        '[KnowledgeRetrieval] pgvector search failed, using DB fallback',
        err instanceof Error ? err.message : err
      );
    }
  }

  const lexical = lexicalMatchKnowledgeItems(pool, params.query, {
    limit: params.topK ?? 3,
    score: minScore,
  });
  if (lexical.length > 0) {
    return { source: 'database', chunks: lexical };
  }

  if (params.allowUnscoredDbFallback && pool.length > 0) {
    return {
      source: 'database',
      chunks: fallbackChunks(pool, params.topK ?? 3, minScore),
    };
  }

  return { source: 'none', chunks: [] };
}
