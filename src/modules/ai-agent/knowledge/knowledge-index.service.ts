import type { AiAgentKnowledgeItem } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { config } from '../../../config.js';
import { prisma } from '../../../lib/prisma.js';
import { buildKnowledgeItemText, chunkText } from './chunk-text.js';
import { embedQuery, embedTexts, isEmbeddingAvailable } from './embedding.service.js';

export type KnowledgeSearchHit = {
  knowledgeItemId: string;
  title: string;
  content: string;
  score: number;
};

function cuidLike(): string {
  return `ck${randomBytes(12).toString('hex')}`;
}

/** pgvector text literal: [0.1,0.2,...] */
function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export class KnowledgeIndexService {
  isEnabled(): boolean {
    return isEmbeddingAvailable();
  }

  async indexItem(workspaceId: string, item: AiAgentKnowledgeItem): Promise<void> {
    if (!this.isEnabled()) {
      console.warn('[KnowledgeIndex] Skipped (OpenAI embeddings not configured)', item.id);
      return;
    }

    const sourceText = buildKnowledgeItemText(item);
    if (!sourceText) return;

    const chunks = chunkText(sourceText);
    if (chunks.length === 0) return;

    await this.deleteItemVectors(workspaceId, item.id);

    const embeddings = await embedTexts(chunks);
    const now = new Date();

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const embedding = embeddings[chunkIndex];
      if (!embedding?.length) continue;

      await prisma.$executeRawUnsafe(
        `INSERT INTO knowledge_chunks
          (id, "workspaceId", "agentId", "knowledgeItemId", "chunkIndex", title, content, embedding, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10)`,
        cuidLike(),
        workspaceId,
        item.agentId,
        item.id,
        chunkIndex,
        item.title,
        chunks[chunkIndex],
        toVectorLiteral(embedding),
        now,
        now
      );
    }

    console.info(
      '[KnowledgeIndex] Upserted',
      chunks.length,
      'chunk(s) for',
      item.id,
      'via pgvector'
    );
  }

  async deleteItemVectors(_workspaceId: string, knowledgeItemId: string): Promise<void> {
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM knowledge_chunks WHERE "knowledgeItemId" = $1`,
        knowledgeItemId
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Table missing before first migration — ignore so upsert/create can proceed later.
      if (/does not exist|undefined_table/i.test(msg)) return;
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
    const topK = params.topK ?? config.embeddings.topK;
    const vector = toVectorLiteral(embedding);

    type Row = {
      knowledgeItemId: string;
      title: string;
      content: string;
      score: number;
    };

    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT
          "knowledgeItemId",
          title,
          content,
          (1 - (embedding <=> $1::vector))::float8 AS score
       FROM knowledge_chunks
       WHERE "workspaceId" = $2 AND "agentId" = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      vector,
      params.workspaceId,
      params.agentId,
      topK * 4
    );

    const seen = new Set<string>();
    const hits: KnowledgeSearchHit[] = [];
    for (const row of rows) {
      if (seen.has(row.knowledgeItemId)) continue;
      seen.add(row.knowledgeItemId);
      hits.push({
        knowledgeItemId: row.knowledgeItemId,
        title: row.title,
        content: row.content,
        score: row.score,
      });
      if (hits.length >= topK) break;
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
