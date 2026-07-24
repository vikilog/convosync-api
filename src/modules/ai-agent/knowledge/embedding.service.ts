import OpenAI from 'openai';
import { config } from '../../../config.js';

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

export function isEmbeddingAvailable(): boolean {
  return Boolean(openai) && config.embeddings.enabled;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const cleaned = texts.map((text) => text.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  if (!openai) {
    throw new Error('OpenAI is not configured for embeddings');
  }

  const response = await openai.embeddings.create({
    model: config.embeddings.model,
    input: cleaned,
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((row) => row.embedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  if (!embedding) throw new Error('Failed to embed query');
  return embedding;
}
