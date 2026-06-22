import type { Prisma } from '@prisma/client';
import { prisma } from '../../../../index.js';

export const gbpMetricRepository = {
  async listByLocation(workspaceId: string, locationId: string) {
    return prisma.googleBusinessMetric.findMany({
      where: { workspaceId, locationId },
      orderBy: { lastSyncedAt: 'desc' },
    });
  },

  async upsertSnapshot(
    workspaceId: string,
    connectionId: string,
    locationId: string,
    metricType: string,
    value: Prisma.InputJsonValue,
    rawData?: Prisma.InputJsonValue
  ) {
    const now = new Date();
    await prisma.googleBusinessMetric.create({
      data: {
        workspaceId,
        connectionId,
        locationId,
        metricType,
        value,
        rawData: rawData ?? undefined,
        lastSyncedAt: now,
      },
    });

    await prisma.googleBusinessLocation.update({
      where: { id: locationId },
      data: { lastMetricSyncAt: now },
    });
  },

  async latestSync(workspaceId: string, connectionId: string) {
    return prisma.googleBusinessMetric.aggregate({
      where: { workspaceId, connectionId },
      _max: { lastSyncedAt: true },
      _count: true,
    });
  },
};
