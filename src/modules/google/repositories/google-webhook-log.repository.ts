import type { GoogleProductKey, Prisma } from '@prisma/client';
import { prisma } from '../../../index.js';

export const googleWebhookLogRepository = {
  async create(params: {
    workspaceId: string;
    connectionId?: string | null;
    product: GoogleProductKey;
    eventType: string;
    payload?: Record<string, unknown>;
    status: 'received' | 'processed' | 'error';
    error?: string;
  }) {
    return prisma.googleWebhookLog.create({
      data: {
        workspaceId: params.workspaceId,
        connectionId: params.connectionId ?? undefined,
        product: params.product,
        eventType: params.eventType,
        payload: params.payload ? (params.payload as Prisma.InputJsonValue) : undefined,
        status: params.status,
        error: params.error,
        processedAt: params.status === 'processed' ? new Date() : undefined,
      },
    });
  },
};
