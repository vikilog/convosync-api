import type { GoogleProductKey, Prisma } from '@prisma/client';
import { prisma } from '../../../index.js';

export const googleSyncLogRepository = {
  async create(params: {
    workspaceId: string;
    connectionId?: string | null;
    product: GoogleProductKey;
    action: string;
    status: 'success' | 'error';
    message?: string;
    metadata?: Record<string, unknown>;
  }) {
    return prisma.googleSyncLog.create({
      data: {
        workspaceId: params.workspaceId,
        connectionId: params.connectionId ?? undefined,
        product: params.product,
        action: params.action,
        status: params.status,
        message: params.message,
        metadata: params.metadata ? (params.metadata as Prisma.InputJsonValue) : undefined,
      },
    });
  },

  async listRecent(workspaceId: string, product?: GoogleProductKey, limit = 20) {
    return prisma.googleSyncLog.findMany({
      where: {
        workspaceId,
        ...(product ? { product } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};
