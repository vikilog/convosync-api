import type { Prisma, PrismaClient } from '@prisma/client';
import type { NormalizedSalonKnowledge } from '../types/normalized.types.js';
import type { AiKnowledgeDebug } from '../types/debug.types.js';
import type { AiKnowledgeSyncStatus, SyncProgress } from '../types/ai-knowledge.types.js';

export class AiKnowledgeRepository {
  constructor(private readonly db: PrismaClient) {}

  upsertConfig(workspaceId: string, venueId: string, connectionString: string) {
    return this.db.aiKnowledgeConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, venueId, connectionString },
      update: { venueId, connectionString },
    });
  }

  getConfig(workspaceId: string) {
    return this.db.aiKnowledgeConfig.findUnique({ where: { workspaceId } });
  }

  upsertSyncing(workspaceId: string, venueId: string) {
    return this.db.aiKnowledge.upsert({
      where: { workspaceId_venueId: { workspaceId, venueId } },
      create: {
        workspaceId,
        venueId,
        data: {},
        status: 'syncing',
        syncProgress: { step: 0, totalSteps: 15, message: 'Starting sync…' },
      },
      update: {
        status: 'syncing',
        errorMessage: null,
        syncProgress: { step: 0, totalSteps: 15, message: 'Starting sync…' },
      },
    });
  }

  updateProgress(
    workspaceId: string,
    venueId: string,
    progress: SyncProgress
  ) {
    return this.db.aiKnowledge.update({
      where: { workspaceId_venueId: { workspaceId, venueId } },
      data: { syncProgress: progress as Prisma.InputJsonValue },
    });
  }

  /** Persists raw discovery graph before normalization for debugging. */
  saveDebugSnapshot(workspaceId: string, venueId: string, debug: AiKnowledgeDebug) {
    return this.db.aiKnowledge.update({
      where: { workspaceId_venueId: { workspaceId, venueId } },
      data: { debug: debug as Prisma.InputJsonValue },
    });
  }

  saveSuccess(
    workspaceId: string,
    venueId: string,
    data: NormalizedSalonKnowledge,
    debug?: AiKnowledgeDebug
  ) {
    return this.db.aiKnowledge.upsert({
      where: { workspaceId_venueId: { workspaceId, venueId } },
      create: {
        workspaceId,
        venueId,
        data: data as Prisma.InputJsonValue,
        debug: debug ? (debug as Prisma.InputJsonValue) : undefined,
        status: 'success',
        syncedAt: new Date(),
        syncProgress: { step: 15, totalSteps: 15, message: 'Sync complete' },
        errorMessage: null,
      },
      update: {
        data: data as Prisma.InputJsonValue,
        ...(debug ? { debug: debug as Prisma.InputJsonValue } : {}),
        status: 'success',
        syncedAt: new Date(),
        syncProgress: { step: 15, totalSteps: 15, message: 'Sync complete' },
        errorMessage: null,
      },
    });
  }

  saveFailure(workspaceId: string, venueId: string, errorMessage: string) {
    return this.db.aiKnowledge.upsert({
      where: { workspaceId_venueId: { workspaceId, venueId } },
      create: {
        workspaceId,
        venueId,
        data: {},
        status: 'failed',
        errorMessage,
        syncProgress: { step: 0, totalSteps: 15, message: errorMessage },
      },
      update: {
        status: 'failed',
        errorMessage,
        syncProgress: { step: 0, totalSteps: 15, message: errorMessage },
      },
    });
  }

  findByVenue(workspaceId: string, venueId: string) {
    return this.db.aiKnowledge.findUnique({
      where: { workspaceId_venueId: { workspaceId, venueId } },
    });
  }

  findLatestForWorkspace(workspaceId: string) {
    return this.db.aiKnowledge.findFirst({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
  }
}

export function mapRecordStatus(status: string): AiKnowledgeSyncStatus {
  if (status === 'syncing' || status === 'success' || status === 'failed') {
    return status;
  }
  return 'pending';
}
