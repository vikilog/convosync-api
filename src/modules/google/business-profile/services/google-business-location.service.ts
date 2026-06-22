import type { GoogleBusinessLocation } from '@prisma/client';
import { gbpLocationRepository } from '../repositories/gbp-location.repository.js';
import { googleBusinessCacheService } from './google-business-cache.service.js';

export class GoogleBusinessLocationService {
  async listByAccountFromCache(
    workspaceId: string,
    connectionId: string,
    accountId: string
  ): Promise<GoogleBusinessLocation[]> {
    const cached = await googleBusinessCacheService.get<GoogleBusinessLocation[]>(
      'locations',
      workspaceId,
      connectionId,
      accountId
    );
    if (cached) return cached;

    const rows = await gbpLocationRepository.listByAccount(workspaceId, accountId);
    if (rows.length > 0) {
      await googleBusinessCacheService.set(
        'locations',
        workspaceId,
        connectionId,
        rows,
        accountId
      );
    }
    return rows;
  }

  async getById(workspaceId: string, id: string) {
    return gbpLocationRepository.findById(workspaceId, id);
  }
}

export const googleBusinessLocationService = new GoogleBusinessLocationService();
