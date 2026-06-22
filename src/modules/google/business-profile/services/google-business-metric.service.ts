import type { GoogleBusinessMetric } from '@prisma/client';
import { gbpMetricRepository } from '../repositories/gbp-metric.repository.js';
import { googleBusinessCacheService } from './google-business-cache.service.js';

export class GoogleBusinessMetricService {
  async listByLocationFromCache(
    workspaceId: string,
    connectionId: string,
    locationId: string
  ): Promise<GoogleBusinessMetric[]> {
    const cached = await googleBusinessCacheService.get<GoogleBusinessMetric[]>(
      'metrics',
      workspaceId,
      connectionId,
      locationId
    );
    if (cached) return cached;

    const rows = await gbpMetricRepository.listByLocation(workspaceId, locationId);
    await googleBusinessCacheService.set(
      'metrics',
      workspaceId,
      connectionId,
      rows,
      locationId
    );
    return rows;
  }
}

export const googleBusinessMetricService = new GoogleBusinessMetricService();
