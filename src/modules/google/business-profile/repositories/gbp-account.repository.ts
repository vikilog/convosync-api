import type { Prisma } from '@prisma/client';
import { prisma } from '../../../../index.js';

export const gbpAccountRepository = {
  async listByConnection(workspaceId: string, connectionId: string) {
    return prisma.googleBusinessAccount.findMany({
      where: { workspaceId, connectionId },
      orderBy: { displayName: 'asc' },
    });
  },

  async findById(workspaceId: string, id: string) {
    return prisma.googleBusinessAccount.findFirst({ where: { workspaceId, id } });
  },

  async upsertMany(
    workspaceId: string,
    connectionId: string,
    accounts: Array<{
      googleAccountName: string;
      displayName?: string | null;
      accountType?: string | null;
      rawData?: Prisma.InputJsonValue;
    }>
  ) {
    const now = new Date();
    for (const account of accounts) {
      await prisma.googleBusinessAccount.upsert({
        where: {
          connectionId_googleAccountName: {
            connectionId,
            googleAccountName: account.googleAccountName,
          },
        },
        create: {
          workspaceId,
          connectionId,
          googleAccountName: account.googleAccountName,
          displayName: account.displayName ?? null,
          accountType: account.accountType ?? null,
          rawData: account.rawData ?? undefined,
          lastSyncedAt: now,
          lastSuccessAt: now,
          syncStatus: 'success',
        },
        update: {
          displayName: account.displayName ?? null,
          accountType: account.accountType ?? null,
          rawData: account.rawData ?? undefined,
          lastSyncedAt: now,
          lastSuccessAt: now,
          lastError: null,
          syncStatus: 'success',
        },
      });
    }
  },

  async markSyncing(workspaceId: string, connectionId: string) {
    await prisma.googleBusinessAccount.updateMany({
      where: { workspaceId, connectionId },
      data: { syncStatus: 'syncing' },
    });
  },

  async markError(workspaceId: string, connectionId: string, error: string) {
    await prisma.googleBusinessAccount.updateMany({
      where: { workspaceId, connectionId },
      data: { syncStatus: 'error', lastError: error, lastSyncedAt: new Date() },
    });
  },

  async latestSync(workspaceId: string, connectionId: string) {
    return prisma.googleBusinessAccount.aggregate({
      where: { workspaceId, connectionId },
      _max: { lastSyncedAt: true },
      _count: true,
    });
  },

  async getSyncStatuses(workspaceId: string, connectionId: string) {
    return prisma.googleBusinessAccount.findMany({
      where: { workspaceId, connectionId },
      select: { syncStatus: true },
    });
  },
};
