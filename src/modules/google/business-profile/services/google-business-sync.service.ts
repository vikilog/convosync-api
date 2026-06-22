import type { GoogleBusinessSyncType, Prisma } from '@prisma/client';
import { googleService } from '../../services/google.service.js';
import { GoogleBusinessProfileProvider } from '../../providers/business-profile.provider.js';
import { gbpAccountRepository } from '../repositories/gbp-account.repository.js';
import { gbpLocationRepository } from '../repositories/gbp-location.repository.js';
import { gbpReviewRepository } from '../repositories/gbp-review.repository.js';
import { gbpMetricRepository } from '../repositories/gbp-metric.repository.js';
import { gbpSyncLogRepository } from '../repositories/gbp-sync-log.repository.js';
import { googleBusinessApiService } from './google-business-api.service.js';
import { googleBusinessCacheService } from './google-business-cache.service.js';
import { getGbpSyncQueue, type GbpSyncJobData } from '../queue/gbp-sync.queue.js';

type SyncResult = {
  requestCount: number;
  responseCount: number;
};

export class GoogleBusinessSyncService {
  async enqueue(
    workspaceId: string,
    connectionId: string,
    syncType: GoogleBusinessSyncType,
    opts?: { accountId?: string; locationId?: string; force?: boolean }
  ): Promise<string> {
    const job = await getGbpSyncQueue().add(
      syncType,
      { workspaceId, connectionId, syncType, ...opts },
      {
        jobId: opts?.force
          ? undefined
          : `${syncType}:${connectionId}:${opts?.accountId ?? 'all'}:${opts?.locationId ?? 'all'}`,
        removeOnComplete: 200,
        removeOnFail: 500,
      }
    );
    return job.id ?? '';
  }

  async runJob(data: GbpSyncJobData): Promise<void> {
    switch (data.syncType) {
      case 'accounts':
        await this.syncAccounts(data.workspaceId, data.connectionId);
        break;
      case 'locations':
        if (!data.accountId) throw new Error('accountId required for locations sync');
        await this.syncLocations(data.workspaceId, data.connectionId, data.accountId);
        break;
      case 'reviews':
        if (!data.locationId) throw new Error('locationId required for reviews sync');
        await this.syncReviews(data.workspaceId, data.connectionId, data.locationId);
        break;
      case 'metrics':
        if (!data.locationId) throw new Error('locationId required for metrics sync');
        await this.syncMetrics(data.workspaceId, data.connectionId, data.locationId);
        break;
      case 'cache_rebuild':
        await googleBusinessCacheService.invalidateConnection(
          data.workspaceId,
          data.connectionId
        );
        await this.syncAccounts(data.workspaceId, data.connectionId);
        {
          const accounts = await gbpAccountRepository.listByConnection(
            data.workspaceId,
            data.connectionId
          );
          for (const account of accounts) {
            await this.syncLocations(data.workspaceId, data.connectionId, account.id);
          }
        }
        break;
      default:
        throw new Error(`Unknown sync type: ${data.syncType}`);
    }
  }

  async syncAccounts(workspaceId: string, connectionId: string): Promise<SyncResult> {
    const started = Date.now();
    let requestCount = 0;
    let responseCount = 0;

    await gbpAccountRepository.markSyncing(workspaceId, connectionId);

    try {
      const provider = googleService.getProvider(
        'business_profile'
      ) as GoogleBusinessProfileProvider;
      const ctx = await provider.context(connectionId, workspaceId);

      requestCount += 1;
      const accounts = await googleBusinessApiService.listAccounts(ctx);
      responseCount = accounts.length;

      await gbpAccountRepository.upsertMany(
        workspaceId,
        connectionId,
        accounts.map((a) => ({
          googleAccountName: a.name ?? '',
          displayName: a.accountName ?? null,
          accountType: a.type ?? null,
          rawData: a as Prisma.InputJsonValue,
        }))
      );

      await googleBusinessCacheService.invalidateConnection(workspaceId, connectionId);

      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'accounts',
        durationMs: Date.now() - started,
        requestCount,
        responseCount,
        status: 'success',
      });

      return { requestCount, responseCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Accounts sync failed';
      await gbpAccountRepository.markError(workspaceId, connectionId, message);
      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'accounts',
        durationMs: Date.now() - started,
        requestCount,
        responseCount,
        status: 'error',
        error: message,
      });
      throw err;
    }
  }

  async syncLocations(
    workspaceId: string,
    connectionId: string,
    accountId: string
  ): Promise<SyncResult> {
    const started = Date.now();
    let requestCount = 0;
    let responseCount = 0;

    const account = await gbpAccountRepository.findById(workspaceId, accountId);
    if (!account) throw new Error('Account not found');

    await gbpLocationRepository.markSyncing(workspaceId, accountId);

    try {
      const provider = googleService.getProvider(
        'business_profile'
      ) as GoogleBusinessProfileProvider;
      const ctx = await provider.context(connectionId, workspaceId);

      requestCount += 1;
      const locations = await googleBusinessApiService.listLocations(
        ctx,
        account.googleAccountName
      );
      responseCount = locations.length;

      await gbpLocationRepository.upsertMany(workspaceId, connectionId, accountId, locations.map((loc) => ({
        googleLocationName: loc.name ?? '',
        title: loc.title ?? null,
        address: loc.storefrontAddress as Prisma.InputJsonValue | undefined,
        regularHours: loc.regularHours as Prisma.InputJsonValue | undefined,
        metadata: loc.metadata as Prisma.InputJsonValue | undefined,
        rawData: loc as Prisma.InputJsonValue,
      })));

      await googleBusinessCacheService.set(
        'locations',
        workspaceId,
        connectionId,
        await gbpLocationRepository.listByAccount(workspaceId, accountId),
        accountId
      );

      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'locations',
        durationMs: Date.now() - started,
        requestCount,
        responseCount,
        status: 'success',
        metadata: { accountId },
      });

      return { requestCount, responseCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Locations sync failed';
      await gbpLocationRepository.markError(workspaceId, accountId, message);
      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'locations',
        durationMs: Date.now() - started,
        requestCount,
        responseCount,
        status: 'error',
        error: message,
        metadata: { accountId },
      });
      throw err;
    }
  }

  async syncReviews(
    workspaceId: string,
    connectionId: string,
    locationId: string
  ): Promise<SyncResult> {
    const started = Date.now();
    let requestCount = 0;
    let responseCount = 0;

    const location = await gbpLocationRepository.findById(workspaceId, locationId);
    if (!location) throw new Error('Location not found');

    try {
      const provider = googleService.getProvider(
        'business_profile'
      ) as GoogleBusinessProfileProvider;
      const ctx = await provider.context(connectionId, workspaceId);

      requestCount += 1;
      const since = location.lastReviewSyncAt ?? undefined;
      const reviews = await googleBusinessApiService.listReviews(
        ctx,
        location.googleLocationName,
        since ?? undefined
      );
      responseCount = reviews.length;

      if (reviews.length > 0) {
        await gbpReviewRepository.upsertMany(
          workspaceId,
          connectionId,
          locationId,
          reviews.map((r, i) => ({
            googleReviewId: String(r.name ?? r.reviewId ?? `review-${i}`),
            reviewerName: (r.reviewer as { displayName?: string })?.displayName ?? null,
            starRating: typeof r.starRating === 'number' ? r.starRating : null,
            comment: typeof r.comment === 'string' ? r.comment : null,
            reviewReply: (r.reviewReply as { comment?: string })?.comment ?? null,
            createTime: r.createTime ? new Date(String(r.createTime)) : null,
            updateTime: r.updateTime ? new Date(String(r.updateTime)) : null,
            rawData: r as Prisma.InputJsonValue,
          }))
        );
      } else if (!since) {
        await gbpReviewRepository.upsertMany(workspaceId, connectionId, locationId, []);
      }

      await googleBusinessCacheService.set(
        'reviews',
        workspaceId,
        connectionId,
        await gbpReviewRepository.listByLocation(workspaceId, locationId),
        locationId
      );

      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'reviews',
        durationMs: Date.now() - started,
        requestCount,
        responseCount,
        status: 'success',
        metadata: { locationId, incremental: Boolean(since) },
      });

      return { requestCount, responseCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reviews sync failed';
      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'reviews',
        durationMs: Date.now() - started,
        requestCount,
        responseCount,
        status: 'error',
        error: message,
        metadata: { locationId },
      });
      throw err;
    }
  }

  async syncMetrics(
    workspaceId: string,
    connectionId: string,
    locationId: string
  ): Promise<SyncResult> {
    const started = Date.now();
    let requestCount = 0;
    const responseCount = 1;

    const location = await gbpLocationRepository.findById(workspaceId, locationId);
    if (!location) throw new Error('Location not found');

    try {
      const provider = googleService.getProvider(
        'business_profile'
      ) as GoogleBusinessProfileProvider;
      const ctx = await provider.context(connectionId, workspaceId);

      requestCount += 1;
      const metrics = await provider.getReviewMetrics(ctx, location.googleLocationName);

      await gbpMetricRepository.upsertSnapshot(
        workspaceId,
        connectionId,
        locationId,
        'review_summary',
        {
          totalReviews: metrics.totalReviews,
          averageRating: metrics.averageRating,
          lastSyncedAt: new Date().toISOString(),
        },
        metrics as Prisma.InputJsonValue
      );

      await googleBusinessCacheService.set(
        'metrics',
        workspaceId,
        connectionId,
        await gbpMetricRepository.listByLocation(workspaceId, locationId),
        locationId
      );

      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'metrics',
        durationMs: Date.now() - started,
        requestCount,
        responseCount,
        status: 'success',
        metadata: { locationId },
      });

      return { requestCount, responseCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Metrics sync failed';
      await gbpSyncLogRepository.create({
        workspaceId,
        connectionId,
        syncType: 'metrics',
        durationMs: Date.now() - started,
        requestCount,
        responseCount: 0,
        status: 'error',
        error: message,
        metadata: { locationId },
      });
      throw err;
    }
  }

  async getSyncStatus(workspaceId: string, connectionId: string) {
    const queue = getGbpSyncQueue();
    const [waiting, active, failed, accounts, locations, reviews, metrics, recentErrors] =
      await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getFailedCount(),
        gbpAccountRepository.latestSync(workspaceId, connectionId),
        gbpLocationRepository.latestSync(workspaceId, connectionId),
        gbpReviewRepository.latestSync(workspaceId, connectionId),
        gbpMetricRepository.latestSync(workspaceId, connectionId),
        gbpSyncLogRepository.recentErrors(
          workspaceId,
          connectionId,
          new Date(Date.now() - 60 * 60 * 1000)
        ),
      ]);

    const accountStatuses = await gbpAccountRepository.getSyncStatuses(
      workspaceId,
      connectionId
    );
    const hasSyncing = accountStatuses.some((s) => s.syncStatus === 'syncing');
    const hasError = accountStatuses.some((s) => s.syncStatus === 'error');

    return {
      lastSync: {
        accounts: accounts._max.lastSyncedAt,
        locations: locations._max.lastLocationSyncAt,
        reviews: reviews._max.lastSyncedAt,
        metrics: metrics._max.lastSyncedAt,
      },
      counts: {
        accounts: accounts._count,
        locations: locations._count,
        reviews: reviews._count,
        metrics: metrics._count,
      },
      jobs: { waiting, active, failed },
      quotaHealth:
        recentErrors >= 3 || hasError ? 'degraded' : hasSyncing ? 'busy' : 'healthy',
    };
  }
}

export const googleBusinessSyncService = new GoogleBusinessSyncService();
