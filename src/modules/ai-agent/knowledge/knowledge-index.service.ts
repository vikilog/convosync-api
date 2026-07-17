import type { AiAgentKnowledgeItem } from '@prisma/client';
import { config } from '../../../config.js';
import { buildKnowledgeItemText, chunkText } from './chunk-text.js';
import { embedQuery, embedTexts, isEmbeddingAvailable } from './embedding.service.js';
import { getPineconeIndex, isPineconeConfigured } from './pinecone.client.js';

const MAX_METADATA_TEXT = 3500;

export type KnowledgeSearchHit = {
  knowledgeItemId: string;
  title: string;
  content: string;
  score: number;
};

function vectorId(knowledgeItemId: string, chunkIndex: number): string {
  return `${knowledgeItemId}__${chunkIndex}`;
}

function namespaceForWorkspace(workspaceId: string): string {
  return workspaceId;
}

function truncateMetadata(text: string): string {
  if (text.length <= MAX_METADATA_TEXT) return text;
  return `${text.slice(0, MAX_METADATA_TEXT)}…`;
}

export class KnowledgeIndexService {
  isEnabled(): boolean {
    return isPineconeConfigured() && isEmbeddingAvailable();
  }

  async indexItem(workspaceId: string, item: AiAgentKnowledgeItem): Promise<void> {
    if (!this.isEnabled()) {
      console.warn(
        '[KnowledgeIndex] Skipped (Pinecone/embeddings not configured)',
        item.id
      );
      return;
    }

    const sourceText = buildKnowledgeItemText(item);
    if (!sourceText) return;

    const chunks = chunkText(sourceText);
    if (chunks.length === 0) return;

    // Re-index: clear prior vectors first. 404 = empty/missing ns — upsert still proceeds.
    await this.deleteItemVectors(workspaceId, item.id);

    const embeddings = await embedTexts(chunks);
    const index = getPineconeIndex();
    const ns = namespaceForWorkspace(workspaceId);
    const records = chunks.map((chunk, chunkIndex) => ({
      id: vectorId(item.id, chunkIndex),
      values: embeddings[chunkIndex],
      metadata: {
        workspaceId,
        agentId: item.agentId,
        knowledgeItemId: item.id,
        title: item.title,
        type: item.type,
        chunkIndex,
        text: truncateMetadata(chunk),
      },
    }));

    await index.namespace(ns).upsert({ records });
    console.info(
      '[KnowledgeIndex] Upserted',
      records.length,
      'vector(s) for',
      item.id,
      'ns=',
      ns,
      'index=',
      config.pinecone.indexName
    );
  }

  async deleteItemVectors(workspaceId: string, knowledgeItemId: string): Promise<void> {
    if (!isPineconeConfigured()) return;

    try {
      const index = getPineconeIndex();
      await index.namespace(namespaceForWorkspace(workspaceId)).deleteMany({
        filter: { knowledgeItemId: { $eq: knowledgeItemId } },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // First index / missing namespace / stale host often 404 — ignore so upsert can run.
      if (/404|not.?found/i.test(msg) || (err as { name?: string })?.name === 'PineconeNotFoundError') {
        return;
      }
      throw err;
    }
  }

  async search(params: {
    workspaceId: string;
    agentId: string;
    query: string;
    topK?: number;
  }): Promise<KnowledgeSearchHit[]> {
    if (!this.isEnabled()) return [];

    const query = params.query.trim();
    if (!query) return [];

    const embedding = await embedQuery(query);
    const index = getPineconeIndex();
    const response = await index.namespace(namespaceForWorkspace(params.workspaceId)).query({
      vector: embedding,
      topK: params.topK ?? config.pinecone.topK,
      includeMetadata: true,
      filter: {
        agentId: { $eq: params.agentId },
      },
    });

    const seen = new Set<string>();
    const hits: KnowledgeSearchHit[] = [];

    for (const match of response.matches ?? []) {
      const metadata = match.metadata as
        | {
            knowledgeItemId?: string;
            title?: string;
            text?: string;
          }
        | undefined;

      const knowledgeItemId = metadata?.knowledgeItemId;
      const text = metadata?.text;
      if (!knowledgeItemId || !text) continue;
      if (seen.has(knowledgeItemId)) continue;

      seen.add(knowledgeItemId);
      hits.push({
        knowledgeItemId,
        title: metadata?.title ?? 'Knowledge',
        content: text,
        score: match.score ?? 0,
      });
    }

    return hits;
  }
}

export const knowledgeIndexService = new KnowledgeIndexService();

export async function indexKnowledgeItemInBackground(
  workspaceId: string,
  item: AiAgentKnowledgeItem
): Promise<void> {
  try {
    await knowledgeIndexService.indexItem(workspaceId, item);
  } catch (err) {
    console.error('[KnowledgeIndex] Failed to index item', item.id, err);
  }
}
