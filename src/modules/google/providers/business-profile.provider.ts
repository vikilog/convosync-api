import { BaseGoogleProvider, type GoogleProviderContext } from './base.provider.js';
import { googleBusinessApiService } from '../business-profile/services/google-business-api.service.js';
import { googleBusinessSyncService } from '../business-profile/services/google-business-sync.service.js';

export class GoogleBusinessProfileProvider extends BaseGoogleProvider {
  readonly product = 'business_profile' as const;

  /** Enqueues background accounts sync — no direct API from connect hook. */
  async connect(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    await googleBusinessSyncService.enqueue(ctx.workspaceId, ctx.connectionId, 'accounts', {
      force: true,
    });
    return { accountsSyncQueued: true };
  }

  async sync(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    await googleBusinessSyncService.enqueue(ctx.workspaceId, ctx.connectionId, 'accounts', {
      force: true,
    });
    return { accountsSyncQueued: true };
  }

  async syncLocations(ctx: GoogleProviderContext, accountName: string) {
    const locations = await googleBusinessApiService.listLocations(ctx, accountName);
    return { locations };
  }

  async syncBusinessHours(ctx: GoogleProviderContext, locationName: string) {
    const data = await googleBusinessApiService.getLocationHours(ctx, locationName);
    return { regularHours: data.regularHours, specialHours: data.specialHours };
  }

  async syncReviews(ctx: GoogleProviderContext, locationName: string) {
    const reviews = await googleBusinessApiService.listReviews(ctx, locationName);
    return {
      locationName,
      reviews,
      note:
        reviews.length === 0
          ? 'Review sync registered — wire to GBP reviews endpoint when API access is enabled.'
          : undefined,
    };
  }

  async getReviewMetrics(ctx: GoogleProviderContext, locationName: string) {
    const reviews = await googleBusinessApiService.listReviews(ctx, locationName);
    return {
      locationName,
      totalReviews: reviews.length,
      averageRating: null,
      lastSyncedReviews: reviews,
    };
  }
}
