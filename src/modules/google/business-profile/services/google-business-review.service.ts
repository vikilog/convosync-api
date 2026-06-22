import type { GoogleBusinessReview } from '@prisma/client';
import { gbpReviewRepository } from '../repositories/gbp-review.repository.js';
import { googleBusinessCacheService } from './google-business-cache.service.js';

export class GoogleBusinessReviewService {
  async listByLocationFromCache(
    workspaceId: string,
    connectionId: string,
    locationId: string
  ): Promise<GoogleBusinessReview[]> {
    const cached = await googleBusinessCacheService.get<GoogleBusinessReview[]>(
      'reviews',
      workspaceId,
      connectionId,
      locationId
    );
    if (cached) return cached;

    const rows = await gbpReviewRepository.listByLocation(workspaceId, locationId);
    await googleBusinessCacheService.set(
      'reviews',
      workspaceId,
      connectionId,
      rows,
      locationId
    );
    return rows;
  }
}

export const googleBusinessReviewService = new GoogleBusinessReviewService();
