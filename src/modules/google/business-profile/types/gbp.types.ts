import type { GoogleBusinessSyncType } from '@prisma/client';

export type GbpSyncJobName =
  | 'accounts-sync'
  | 'locations-sync'
  | 'reviews-sync'
  | 'metrics-sync'
  | 'cache-rebuild'
  | 'auto-sync-tick';

export type GbpSyncJobData = {
  workspaceId: string;
  connectionId: string;
  syncType?: GoogleBusinessSyncType;
  accountId?: string;
  locationId?: string;
  googleAccountName?: string;
  googleLocationName?: string;
  force?: boolean;
};

export type GbpSyncResult = {
  requestCount: number;
  responseCount: number;
  status: 'success' | 'error' | 'partial';
  error?: string;
};

export type GbpSyncStatusSummary = {
  connectionId: string;
  accounts: { lastSyncedAt: string | null; syncStatus: string; count: number };
  locations: { lastSyncedAt: string | null; syncStatus: string; count: number };
  reviews: { lastSyncedAt: string | null; count: number };
  metrics: { lastSyncedAt: string | null; count: number };
  pendingJobs: number;
  failedJobs: number;
  quotaHealth: 'healthy' | 'degraded' | 'exhausted';
  lastError: string | null;
};
