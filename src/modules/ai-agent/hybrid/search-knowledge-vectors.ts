import { SpanStatusCode } from '@opentelemetry/api';
import { config } from '../../../config.js';
import { otelTracer } from '../../../lib/otel.js';
import { knowledgeIndexService } from '../knowledge/knowledge-index.service.js';
import { withBackoff } from './retry.js';
import type { HybridHit, RetrievalPath } from './types.js';

export type VectorSearchResult = {
  hits: HybridHit[];
  topScore: number | null;
  ok: boolean;
};

async function searchKnowledgeVectorsRaw(params: {
  workspaceId: string;
  agentId: string;
  query: string;
  topK?: number;
  knowledgeItemIds?: string[];
}): Promise<VectorSearchResult> {
  if (!knowledgeIndexService.isEnabled()) {
    return { hits: [], topScore: null, ok: true };
  }

  try {
    const hits = await withBackoff(
      () =>
        knowledgeIndexService.search({
          workspaceId: params.workspaceId,
          agentId: params.agentId,
          query: params.query,
          topK: params.topK ?? config.ai.hybridTopK,
          knowledgeItemIds: params.knowledgeItemIds,
        }),
      { label: 'pgvector-search' }
    );

    const mapped: HybridHit[] = hits.map((h) => ({
      knowledgeItemId: h.knowledgeItemId,
      title: h.title,
      content: h.content,
      score: h.score,
    }));

    return {
      hits: mapped,
      topScore: mapped[0]?.score ?? null,
      ok: true,
    };
  } catch (err) {
    console.error('[HybridRetrieval] pgvector search failed', err);
    return { hits: [], topScore: null, ok: false };
  }
}

/**
 * Embed + query pgvector. Optionally attach retrieval `path` after routing
 * (pass `resolvePath`) so the span has score + path + agentId together.
 */
export async function searchKnowledgeVectors(params: {
  workspaceId: string;
  agentId: string;
  query: string;
  topK?: number;
  knowledgeItemIds?: string[];
  /** When provided, called with search result to set `path` on the same span. */
  resolvePath?: (search: VectorSearchResult) => RetrievalPath;
}): Promise<VectorSearchResult> {
  return otelTracer.startActiveSpan('retrieval.pgvector', async (span) => {
    span.setAttribute('agentId', params.agentId);
    span.setAttribute('workspaceId', params.workspaceId);

    try {
      const result = await searchKnowledgeVectorsRaw(params);
      if (result.topScore != null) span.setAttribute('score', result.topScore);
      if (params.resolvePath) {
        span.setAttribute('path', params.resolvePath(result));
      }
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
