import OpenAI from 'openai';
import { config } from '../../../config.js';
import { getPineconeClient } from './pinecone.client.js';

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

export function isEmbeddingAvailable(): boolean {
  if (!config.pinecone.enabled) return false;
  if (config.pinecone.embeddingProvider === 'openai') {
    return Boolean(openai);
  }
  return true;
}

async function embedWithPinecone(
  texts: string[],
  inputType: 'passage' | 'query'
): Promise<number[][]> {
  const pc = getPineconeClient();
  const response = await pc.inference.embed({
    model: config.pinecone.embeddingModel,
    inputs: texts,
    // ponytail: SDK types say Record<string,string> but API accepts numeric dimension
    parameters: {
      inputType,
      truncate: 'END',
      dimension: config.pinecone.embeddingDimension,
    } as never,
  });

  return (response.data ?? []).map((row) => {
    if (row.vectorType === 'dense' && 'values' in row) {
      return row.values;
    }
    return [];
  });
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const cleaned = texts.map((text) => text.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  if (config.pinecone.embeddingProvider === 'pinecone') {
    return embedWithPinecone(cleaned, 'passage');
  }

  if (!openai) {
    throw new Error('OpenAI is not configured for embeddings');
  }

  const response = await openai.embeddings.create({
    model: config.pinecone.embeddingModel,
    input: cleaned,
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((row) => row.embedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  if (config.pinecone.embeddingProvider === 'pinecone') {
    const [embedding] = await embedWithPinecone([text], 'query');
    if (!embedding) throw new Error('Failed to embed query');
    return embedding;
  }

  const [embedding] = await embedTexts([text]);
  if (!embedding) throw new Error('Failed to embed query');
  return embedding;
}
