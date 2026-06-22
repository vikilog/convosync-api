import type { AiKnowledgeRepository } from '../repositories/ai-knowledge.repository.js';
import { mapRecordStatus } from '../repositories/ai-knowledge.repository.js';
import type { MongoSyncService } from './mongo-sync.service.js';
import type { NormalizerService } from './normalizer.service.js';
import type { SyncAiKnowledgeDto, SyncCollectionDto, ListCollectionsDto } from '../dto/ai-knowledge.dto.js';
import type {
  AiKnowledgeConfigRecord,
  AiKnowledgeRecord,
  CollectionSyncResult,
  ListCollectionsResult,
  SyncResult,
} from '../types/ai-knowledge.types.js';
import type { NormalizedSalonKnowledge } from '../types/normalized.types.js';
import type { AiKnowledgeDebug } from '../types/debug.types.js';
import { buildKnowledgeChunks } from '../embeddings/embedding.provider.js';
import { maskConnectionString } from '../utils/field-utils.js';
import { rebuildBundleFromCollections } from '../utils/bundle-builder.js';
import { inspectVenueStructure, venueDocumentPreview } from '../utils/venue-structure-inspector.js';
import { extractVenueScopeContext } from '../utils/venue-scope-fields.js';
import { eventBus } from '../../journey/events/event-bus.js';

function serializeRecord(row: {
  id: string;
  workspaceId: string;
  venueId: string;
  data: unknown;
  debug?: unknown;
  status: string;
  errorMessage: string | null;
  syncProgress: unknown;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AiKnowledgeRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    venueId: row.venueId,
    data: (row.data ?? {}) as NormalizedSalonKnowledge,
    debug: (row.debug ?? null) as AiKnowledgeDebug | null,
    status: mapRecordStatus(row.status),
    errorMessage: row.errorMessage,
    syncProgress: row.syncProgress as AiKnowledgeRecord['syncProgress'],
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AIKnowledgeService {
  constructor(
    private readonly repo: AiKnowledgeRepository,
    private readonly mongoSync: MongoSyncService,
    private readonly normalizer: NormalizerService
  ) {}

  async getConfig(workspaceId: string): Promise<AiKnowledgeConfigRecord> {
    const config = await this.repo.getConfig(workspaceId);
    if (!config) {
      return {
        venueId: null,
        connectionStringMasked: null,
        hasConnectionString: false,
        updatedAt: null,
      };
    }
    return {
      venueId: config.venueId,
      connectionStringMasked: config.connectionString
        ? maskConnectionString(config.connectionString)
        : null,
      hasConnectionString: Boolean(config.connectionString),
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  async saveConfig(
    workspaceId: string,
    venueId: string,
    connectionString?: string
  ): Promise<AiKnowledgeConfigRecord> {
    const existing = await this.repo.getConfig(workspaceId);
    const conn = connectionString ?? existing?.connectionString ?? '';
    if (!conn) {
      throw new Error('Connection string is required when saving config for the first time');
    }
    const saved = await this.repo.upsertConfig(workspaceId, venueId, conn);
    return {
      venueId: saved.venueId,
      connectionStringMasked: maskConnectionString(saved.connectionString ?? ''),
      hasConnectionString: true,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  async getByVenue(workspaceId: string, venueId: string): Promise<AiKnowledgeRecord | null> {
    const row = await this.repo.findByVenue(workspaceId, venueId);
    if (!row) return null;
    return serializeRecord(row);
  }

  /** List syncable collections from external MongoDB (no documents fetched). */
  async listCollections(
    workspaceId: string,
    dto: ListCollectionsDto
  ): Promise<ListCollectionsResult> {
    const { connectionString, venueId } = dto;
    await this.repo.upsertConfig(workspaceId, venueId, connectionString);

    const names = await this.mongoSync.listEntityCollections(connectionString);
    const existing = await this.repo.findByVenue(workspaceId, venueId);
    const debug = (existing?.debug ?? null) as AiKnowledgeDebug | null;
    const synced = new Set(debug?.syncedCollections ?? []);
    const counts = debug?.discoveredGraph?.collections ?? {};

    return {
      venueId,
      total: names.length,
      collections: names.map((name) => ({
        name,
        synced: synced.has(name),
        documentsFound: Array.isArray(counts[name]) ? counts[name].length : null,
      })),
    };
  }

  /**
   * Sync exactly one MongoDB collection and merge into stored knowledge.
   * Fast — safe to call repeatedly, one collection at a time.
   */
  async syncCollection(
    workspaceId: string,
    dto: SyncCollectionDto
  ): Promise<CollectionSyncResult> {
    const { connectionString, venueId, collectionName } = dto;
    await this.repo.upsertConfig(workspaceId, venueId, connectionString);

    const existing = await this.repo.findByVenue(workspaceId, venueId);
    const prevDebug = (existing?.debug ?? null) as AiKnowledgeDebug | null;
    const prevCollections = prevDebug?.discoveredGraph?.collections ?? {};
    const prevVenueDoc =
      (Array.isArray(prevCollections.Venue) ? prevCollections.Venue[0] : null) ??
      prevDebug?.discoveredGraph?.venueDocument ??
      null;
    const venueContext = extractVenueScopeContext(
      prevVenueDoc as Record<string, unknown> | null
    );

    const { docs, log } = await this.mongoSync.fetchSingleCollection(
      connectionString,
      venueId,
      collectionName,
      venueContext
    );

    const plainDocs = docs.map((d) => JSON.parse(JSON.stringify(d)) as Record<string, unknown>);
    const mergedCollections: Record<string, unknown[]> = {
      ...prevCollections,
      [collectionName]: plainDocs,
    };

    const syncedCollections = [
      ...new Set([...(prevDebug?.syncedCollections ?? []), collectionName]),
    ];

    let venueStructure = prevDebug?.venueStructure ?? null;
    if (/^venue(s)?$/i.test(collectionName) && docs[0]) {
      venueStructure = inspectVenueStructure(docs[0], collectionName, venueId);
    }

    const debug: AiKnowledgeDebug = {
      inspectedAt: new Date().toISOString(),
      venueStructure,
      discoveryLogs: [...(prevDebug?.discoveryLogs ?? []), log],
      syncLogs: [
        ...(prevDebug?.syncLogs ?? []),
        {
          collection: collectionName,
          documentsFetched: docs.length,
          durationMs: log.durationMs,
          action: 'fetch',
          detail: `Single collection sync (${log.scopeFieldsTried.join(', ') || 'venueId'})`,
        },
      ],
      objectIdsFoundInVenue: venueStructure?.objectIdCount ?? prevDebug?.objectIdsFoundInVenue ?? 0,
      usedDynamicDiscovery: true,
      syncedCollections,
      discoveredGraph: {
        venueDocument:
          /^venue(s)?$/i.test(collectionName) && docs[0]
            ? venueDocumentPreview(docs[0])
            : prevDebug?.discoveredGraph?.venueDocument ?? null,
        collections: mergedCollections,
      },
    };

    const raw = rebuildBundleFromCollections(mergedCollections);
    raw.debug = debug;
    raw.discoveredByCollection = Object.fromEntries(
      Object.entries(mergedCollections).map(([k, v]) => [k, v as import('mongodb').Document[]])
    );

    const normalized = this.normalizer.normalize(venueId, raw);
    buildKnowledgeChunks(venueId, normalized);
    await this.repo.saveSuccess(workspaceId, venueId, normalized, debug);

    return {
      venueId,
      collectionName,
      documentsFound: docs.length,
      durationMs: log.durationMs,
      status: 'success',
      syncedCollections,
      data: normalized,
      debug,
    };
  }

  /**
   * Starts full sync in the background (legacy). Prefer syncCollection one-by-one.
   */
  async sync(workspaceId: string, dto: SyncAiKnowledgeDto): Promise<SyncResult> {
    const { connectionString, venueId } = dto;

    await this.repo.upsertConfig(workspaceId, venueId, connectionString);
    await this.repo.upsertSyncing(workspaceId, venueId);

    void this.runSyncJob(workspaceId, connectionString, venueId);

    return {
      venueId,
      status: 'syncing',
      syncedAt: null,
      data: {} as NormalizedSalonKnowledge,
      syncProgress: { step: 0, totalSteps: 15, message: 'Sync started…' },
    };
  }

  private async runSyncJob(
    workspaceId: string,
    connectionString: string,
    venueId: string
  ): Promise<void> {
    try {
      const raw = await this.mongoSync.extractSalonData(
        connectionString,
        venueId,
        async (step, totalSteps, message) => {
          await this.repo
            .updateProgress(workspaceId, venueId, { step, totalSteps, message })
            .catch(() => undefined);
        }
      );

      if (raw.debug) {
        await this.repo.saveDebugSnapshot(workspaceId, venueId, raw.debug).catch((err) => {
          console.warn('[AI Knowledge Sync] Failed to save debug snapshot:', err);
        });
      }

      const normalized = this.normalizer.normalize(venueId, raw);
      buildKnowledgeChunks(venueId, normalized);
      await this.repo.saveSuccess(workspaceId, venueId, normalized, raw.debug);
      void eventBus.emit('knowledge.synced', {
        workspaceId,
        venueId,
        syncedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown error during knowledge sync';
      console.error('[AI Knowledge Sync] Job failed:', message);
      await this.repo.saveFailure(workspaceId, venueId, message).catch(() => undefined);
      void eventBus.emit('knowledge.failed', { workspaceId, venueId, error: message });
    }
  }
}
