import { google } from 'googleapis';
import type { GoogleProviderContext } from '../../providers/base.provider.js';
import { googleRateLimiterService } from './google-rate-limiter.service.js';
import { withGoogleRetry } from '../utils/google-api-retry.js';

/**
 * All Google Business Profile API calls — rate-limited, retried, sequential only.
 */
export class GoogleBusinessApiService {
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    return withGoogleRetry(async () => {
      await googleRateLimiterService.acquire();
      return fn();
    });
  }

  async listAccounts(ctx: GoogleProviderContext) {
    return this.call(async () => {
      const api = google.mybusinessaccountmanagement({ version: 'v1', auth: ctx.auth });
      const res = await api.accounts.list();
      return res.data.accounts ?? [];
    });
  }

  async listLocations(ctx: GoogleProviderContext, accountName: string) {
    return this.call(async () => {
      const api = google.mybusinessbusinessinformation({ version: 'v1', auth: ctx.auth });
      const res = await api.accounts.locations.list({
        parent: accountName,
        readMask: 'name,title,storefrontAddress,regularHours,metadata',
      });
      return res.data.locations ?? [];
    });
  }

  async getLocationHours(ctx: GoogleProviderContext, locationName: string) {
    return this.call(async () => {
      const api = google.mybusinessbusinessinformation({ version: 'v1', auth: ctx.auth });
      const res = await api.locations.get({
        name: locationName,
        readMask: 'regularHours,specialHours',
      });
      return res.data;
    });
  }

  /** Placeholder until GBP reviews API access is enabled. */
  async listReviews(_ctx: GoogleProviderContext, _locationName: string, _since?: Date) {
    return [] as Array<Record<string, unknown>>;
  }
}

export const googleBusinessApiService = new GoogleBusinessApiService();
