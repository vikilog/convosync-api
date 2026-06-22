import type { GoogleBusinessSyncType, Prisma } from '@prisma/client';
import { prisma } from '../../../../index.js';

export const gbpSyncLogRepository = {
  async create(entry: {
    workspaceId: string;
    connectionId: string;
    syncType: GoogleBusinessSyncType;
    durationMs?: number;
    requestCount?: number;
    responseCount?: number;
    status: string;
    error?: string | null;
    metadata?: Prisma.InputJsonValue;
  }) {
    return prisma.googleBusinessSyncLog.create({ data: entry });
  },

  async list(workspaceId: string, connectionId: string, limit = 50) {
    return prisma.googleBusinessSyncLog.findMany({
      where: { workspaceId, connectionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  async recentErrors(workspaceId: string, connectionId: string, since: Date) {
    return prisma.googleBusinessSyncLog.count({
      where: {
        workspaceId,
        connectionId,
        status: 'error',
        createdAt: { gte: since },
      },
    });
  },
};
