export type SyncLogEntry = {
  collection: string;
  documentsFetched: number;
  durationMs: number;
  action: 'fetch' | 'resolve' | 'skip' | 'discover';
  detail?: string;
};

export type ResolvedGraph = {
  rootCollection: string;
  /** Venue/salon root document with references expanded inline. */
  expandedRoot: Record<string, unknown>;
  /** All documents fetched during resolution, grouped by collection name. */
  documentsByCollection: Record<string, Record<string, unknown>[]>;
  syncLogs: SyncLogEntry[];
  stats: {
    totalDocuments: number;
    totalDurationMs: number;
    collectionsTouched: number;
  };
};
