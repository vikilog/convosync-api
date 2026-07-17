import { config } from '../../../config.js';
import { knowledgeIndexService } from '../knowledge/knowledge-index.service.js';
import { withBackoff } from './retry.js';
import type { HybridHit } from './types.js';

export type PineconeSearchResult = {
  hits: HybridHit[];
  topScore: number | null;
  ok: boolean;
};

/** Embed + query Pinecone (workspace namespace, agent filter). Failures → ok:false. */
export async function searchPinecone(params: {
  workspaceId: string;
  agentId: string;
  query: string;
  topK?: number;
}): Promise<PineconeSearchResult> {
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
        }),
      { label: 'pinecone-search' }
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
    console.error('[HybridRetrieval] Pinecone search failed', err);
    return { hits: [], topScore: null, ok: false };
  }
}
