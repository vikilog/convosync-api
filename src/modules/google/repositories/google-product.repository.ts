import type { GoogleProductIntegration, GoogleProductKey, GoogleProductStatus, Prisma } from '@prisma/client';
import { prisma } from '../../../index.js';

export const googleProductRepository = {
  async listByWorkspace(workspaceId: string): Promise<GoogleProductIntegration[]> {
    return prisma.googleProductIntegration.findMany({
      where: { workspaceId },
      include: { connection: true },
      orderBy: { product: 'asc' },
    });
  },

  async findByConnectionAndProduct(
    connectionId: string,
    product: GoogleProductKey
  ): Promise<GoogleProductIntegration | null> {
    return prisma.googleProductIntegration.findUnique({
      where: { connectionId_product: { connectionId, product } },
    });
  },

  async upsertProduct(params: {
    workspaceId: string;
    connectionId: string;
    product: GoogleProductKey;
    status: GoogleProductStatus;
    config?: Record<string, unknown> | null;
  }): Promise<GoogleProductIntegration> {
    return prisma.googleProductIntegration.upsert({
      where: {
        connectionId_product: {
          connectionId: params.connectionId,
          product: params.product,
        },
      },
      create: {
        workspaceId: params.workspaceId,
        connectionId: params.connectionId,
        product: params.product,
        status: params.status,
        config: params.config ? (params.config as Prisma.InputJsonValue) : undefined,
      },
      update: {
        status: params.status,
        ...(params.config !== undefined
          ? { config: params.config as Prisma.InputJsonValue }
          : {}),
        lastError: null,
      },
    });
  },

  async markSynced(
    id: string,
    metadata?: { lastError?: string | null }
  ): Promise<GoogleProductIntegration> {
    return prisma.googleProductIntegration.update({
      where: { id },
      data: {
        lastSyncAt: new Date(),
        syncCount: { increment: 1 },
        lastError: metadata?.lastError ?? null,
        status: metadata?.lastError ? 'error' : 'connected',
      },
    });
  },

  async markError(id: string, error: string): Promise<void> {
    await prisma.googleProductIntegration.update({
      where: { id },
      data: { status: 'error', lastError: error },
    });
  },

  async disconnectProduct(connectionId: string, product: GoogleProductKey): Promise<void> {
    await prisma.googleProductIntegration.updateMany({
      where: { connectionId, product },
      data: { status: 'disconnected', lastError: null },
    });
  },

  async deleteByConnection(connectionId: string): Promise<void> {
    await prisma.googleProductIntegration.deleteMany({ where: { connectionId } });
  },

  async updateConfig(
    id: string,
    config: Record<string, unknown>
  ): Promise<GoogleProductIntegration> {
    return prisma.googleProductIntegration.update({
      where: { id },
      data: { config: config as Prisma.InputJsonValue },
    });
  },
};
