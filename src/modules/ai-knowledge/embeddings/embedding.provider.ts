import type { KnowledgeChunk } from '../types/normalized.types.js';

/**
 * Future embedding pipeline hook.
 * Implement with OpenAI, Cohere, or local models, then push vectors to Pinecone/pgvector.
 */
export interface EmbeddingProvider {
  embed(chunks: KnowledgeChunk[]): Promise<number[][]>;
}

export class NoOpEmbeddingProvider implements EmbeddingProvider {
  async embed(chunks: KnowledgeChunk[]): Promise<number[][]> {
    return chunks.map(() => []);
  }
}

/** Split normalized knowledge into embeddable text chunks (vector DB prep). */
export function buildKnowledgeChunks(
  venueId: string,
  data: import('../types/normalized.types.js').NormalizedSalonKnowledge
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];

  chunks.push({
    id: `${venueId}:salon`,
    sourceType: 'salon',
    sourceId: venueId,
    text: [
      `Salon: ${data.salon.name}`,
      `Phone: ${data.salon.phone}`,
      `Email: ${data.salon.email}`,
      `Address: ${data.salon.address}`,
      `Timezone: ${data.salon.timezone}`,
      `Currency: ${data.salon.currency}`,
    ].join('\n'),
    metadata: { venueId },
  });

  for (const service of data.services) {
    chunks.push({
      id: `${venueId}:service:${service.id}`,
      sourceType: 'service',
      sourceId: service.id,
      text: `Service: ${service.name}. Category: ${service.category}. Duration: ${service.duration} min. Price: ${service.price}. ${service.description}`,
      metadata: { venueId, category: service.category },
    });
  }

  for (const faq of data.faqs) {
    chunks.push({
      id: `${venueId}:faq:${faq.id}`,
      sourceType: 'faq',
      sourceId: faq.id,
      text: `Q: ${faq.question}\nA: ${faq.answer}`,
      metadata: { venueId, category: faq.category },
    });
  }

  return chunks;
}
