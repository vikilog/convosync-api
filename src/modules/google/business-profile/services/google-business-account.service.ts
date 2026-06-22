import type { GoogleBusinessAccount } from '@prisma/client';
import { gbpAccountRepository } from '../repositories/gbp-account.repository.js';
import { googleBusinessCacheService } from './google-business-cache.service.js';

export class GoogleBusinessAccountService {
  async listFromCache(workspaceId: string, connectionId: string): Promise<GoogleBusinessAccount[]> {
    const cached = await googleBusinessCacheService.get<GoogleBusinessAccount[]>(
      'accounts',
      workspaceId,
      connectionId
    );
    if (cached) return cached;

    const rows = await gbpAccountRepository.listByConnection(workspaceId, connectionId);
    if (rows.length > 0) {
      await googleBusinessCacheService.set('accounts', workspaceId, connectionId, rows);
    }
    return rows;
  }

  async getById(workspaceId: string, id: string) {
    return gbpAccountRepository.findById(workspaceId, id);
  }
}

export const googleBusinessAccountService = new GoogleBusinessAccountService();
