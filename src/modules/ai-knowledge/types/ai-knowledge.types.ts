import type { NormalizedSalonKnowledge } from './normalized.types.js';
import type { AiKnowledgeDebug } from './debug.types.js';

export type AiKnowledgeSyncStatus = 'pending' | 'syncing' | 'success' | 'failed';

export type SyncProgress = {
  step: number;
  totalSteps: number;
  message: string;
};

export type AiKnowledgeRecord = {
  id: string;
  workspaceId: string;
  venueId: string;
  data: NormalizedSalonKnowledge;
  debug: AiKnowledgeDebug | null;
  status: AiKnowledgeSyncStatus;
  errorMessage: string | null;
  syncProgress: SyncProgress | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiKnowledgeConfigRecord = {
  venueId: string | null;
  connectionStringMasked: string | null;
  hasConnectionString: boolean;
  updatedAt: string | null;
};

export type SyncResult = {
  venueId: string;
  status: AiKnowledgeSyncStatus;
  syncedAt: string | null;
  data: NormalizedSalonKnowledge;
  debug?: AiKnowledgeDebug | null;
  syncProgress: SyncProgress | null;
  errorMessage?: string;
};

export type CollectionListItem = {
  name: string;
  synced: boolean;
  documentsFound: number | null;
};

export type ListCollectionsResult = {
  venueId: string;
  collections: CollectionListItem[];
  total: number;
};

export type CollectionSyncResult = {
  venueId: string;
  collectionName: string;
  documentsFound: number;
  durationMs: number;
  status: 'success';
  syncedCollections: string[];
  data: NormalizedSalonKnowledge;
  debug: AiKnowledgeDebug;
};
