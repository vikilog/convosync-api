import { Pinecone, type Index } from '@pinecone-database/pinecone';
import { config } from '../../../config.js';

let pineconeClient: Pinecone | null = null;
let pineconeIndex: Index | null = null;

export function isPineconeConfigured(): boolean {
  return config.pinecone.enabled;
}

export function getPineconeClient(): Pinecone {
  if (!config.pinecone.enabled) {
    throw new Error('Pinecone is not configured');
  }

  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: config.pinecone.apiKey });
  }

  return pineconeClient;
}

export function getPineconeIndex(): Index {
  const client = getPineconeClient();

  if (!pineconeIndex) {
    pineconeIndex = config.pinecone.host
      ? client.index(config.pinecone.indexName, config.pinecone.host)
      : client.index(config.pinecone.indexName);
  }

  return pineconeIndex;
}
