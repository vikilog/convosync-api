import type { AiAgentKnowledgeItem } from '@prisma/client';
import { knowledgeIndexService, type KnowledgeSearchHit } from './knowledge-index.service.js';

export type RetrievedKnowledgeChunk = {
  title: string;
  content: string | null;
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

export async function retrieveKnowledgeChunks(params: {
  workspaceId: string;
  agentId: string;
  query: string;
  fallbackItems: Pick<AiAgentKnowledgeItem, 'title' | 'content'>[];
  topK?: number;
}): Promise<{ chunks: RetrievedKnowledgeChunk[]; source: 'pgvector' | 'database' }> {
  if (knowledgeIndexService.isEnabled() && params.query.trim()) {
    try {
      const hits: KnowledgeSearchHit[] = await knowledgeIndexService.search({
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        query: params.query,
        topK: params.topK,
      });

      if (hits.length > 0) {
        return {
          source: 'pgvector',
          chunks: hits.map((hit) => ({
            title: hit.title,
            content: hit.content,
          })),
        };
      }
    } catch (err) {
      // pgvector / embedding failures must not kill the LLM reply — fall back to DB KB.
      console.warn(
        '[KnowledgeRetrieval] pgvector search failed, using DB fallback',
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    source: 'database',
    chunks: fallbackChunks(params.fallbackItems),
  };
}
