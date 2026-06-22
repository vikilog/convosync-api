import type { SyncLogEntry } from './sync-log.types.js';

export type FieldStructureEntry = {
  path: string;
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'array'
    | 'objectId'
    | 'date'
    | 'null'
    | 'other';
  arrayLength?: number;
  nestedObjectKeys?: string[];
  objectIdHex?: string;
  sampleValue?: string;
};

export type VenueStructureReport = {
  venueCollection: string | null;
  venueId: string;
  topLevelKeys: string[];
  fields: FieldStructureEntry[];
  objectIdPaths: string[];
  arraySummaries: Array<{ path: string; length: number; itemType: string }>;
  objectIdCount: number;
};

export type CollectionDiscoveryLog = {
  collection: string;
  documentsFound: number;
  durationMs: number;
  scopeFieldsTried: string[];
  sampleTopLevelKeys: string[];
  detail?: string;
};

/** Raw discovery snapshot stored on ai_knowledge.debug for inspection. */
export type AiKnowledgeDebug = {
  inspectedAt: string;
  venueStructure: VenueStructureReport | null;
  discoveryLogs: CollectionDiscoveryLog[];
  syncLogs: SyncLogEntry[];
  objectIdsFoundInVenue: number;
  usedDynamicDiscovery: boolean;
  discoveredGraph: {
    venueDocument: Record<string, unknown> | null;
    collections: Record<string, unknown[]>;
  };
  /** MongoDB collection names already synced one-by-one. */
  syncedCollections?: string[];
};
