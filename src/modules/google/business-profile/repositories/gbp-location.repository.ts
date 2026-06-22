import type { Prisma } from '@prisma/client';
import { prisma } from '../../../../index.js';

export const gbpLocationRepository = {
  async listByAccount(workspaceId: string, accountId: string) {
    return prisma.googleBusinessLocation.findMany({
      where: { workspaceId, accountId },
      orderBy: { title: 'asc' },
    });
  },

  async findById(workspaceId: string, id: string) {
    return prisma.googleBusinessLocation.findFirst({ where: { workspaceId, id } });
  },

  async upsertMany(
    workspaceId: string,
    connectionId: string,
    accountId: string,
    locations: Array<{
      googleLocationName: string;
      title?: string | null;
      address?: Prisma.InputJsonValue;
      regularHours?: Prisma.InputJsonValue;
      metadata?: Prisma.InputJsonValue;
      rawData?: Prisma.InputJsonValue;
    }>
  ) {
    const now = new Date();
    for (const loc of locations) {
      await prisma.googleBusinessLocation.upsert({
        where: {
          connectionId_googleLocationName: {
            connectionId,
            googleLocationName: loc.googleLocationName,
          },
        },
        create: {
          workspaceId,
          connectionId,
          accountId,
          googleLocationName: loc.googleLocationName,
          title: loc.title ?? null,
          address: loc.address ?? undefined,
          regularHours: loc.regularHours ?? undefined,
          metadata: loc.metadata ?? undefined,
          rawData: loc.rawData ?? undefined,
          lastSyncedAt: now,
          lastLocationSyncAt: now,
          lastSuccessAt: now,
          syncStatus: 'success',
        },
        update: {
          title: loc.title ?? null,
          address: loc.address ?? undefined,
          regularHours: loc.regularHours ?? undefined,
          metadata: loc.metadata ?? undefined,
          rawData: loc.rawData ?? undefined,
          lastSyncedAt: now,
          lastLocationSyncAt: now,
          lastSuccessAt: now,
          lastError: null,
          syncStatus: 'success',
        },
      });
    }
  },

  async markSyncing(workspaceId: string, accountId: string) {
    await prisma.googleBusinessLocation.updateMany({
      where: { workspaceId, accountId },
      data: { syncStatus: 'syncing' },
    });
  },

  async markError(workspaceId: string, accountId: string, error: string) {
    await prisma.googleBusinessLocation.updateMany({
      where: { workspaceId, accountId },
      data: { syncStatus: 'error', lastError: error, lastSyncedAt: new Date() },
    });
  },

  async latestSync(workspaceId: string, connectionId: string) {
    return prisma.googleBusinessLocation.aggregate({
      where: { workspaceId, connectionId },
      _max: { lastLocationSyncAt: true },
      _count: true,
    });
  },

  async listByConnection(workspaceId: string, connectionId: string) {
    return prisma.googleBusinessLocation.findMany({
      where: { workspaceId, connectionId },
      orderBy: { title: 'asc' },
    });
  },
};
