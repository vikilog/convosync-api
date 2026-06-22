import { prisma } from '../../../../index.js';
import { GBP_SYNC_INTERVALS } from '../constants/sync-intervals.js';
import { googleBusinessSyncService } from '../services/google-business-sync.service.js';

const lastRun = new Map<string, number>();

function schedulerKey(connectionId: string, kind: string): string {
  return `${connectionId}:${kind}`;
}

function due(intervalMs: number, key: string): boolean {
  const prev = lastRun.get(key) ?? 0;
  if (Date.now() - prev < intervalMs) return false;
  lastRun.set(key, Date.now());
  return true;
}

/**
 * Periodically enqueues auto-sync jobs for connected GBP integrations.
 */
export function startGbpScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const integrations = await prisma.googleProductIntegration.findMany({
        where: { product: 'business_profile', status: 'connected' },
        select: { workspaceId: true, connectionId: true, lastSyncAt: true },
      });

      for (const row of integrations) {
        const { workspaceId, connectionId } = row;

        if (due(GBP_SYNC_INTERVALS.accounts, schedulerKey(connectionId, 'accounts'))) {
          await googleBusinessSyncService
            .enqueue(workspaceId, connectionId, 'accounts')
            .catch(() => undefined);
        }

        if (due(GBP_SYNC_INTERVALS.locations, schedulerKey(connectionId, 'locations'))) {
          const accounts = await prisma.googleBusinessAccount.findMany({
            where: { workspaceId, connectionId },
            select: { id: true },
          });
          for (const account of accounts) {
            await googleBusinessSyncService
              .enqueue(workspaceId, connectionId, 'locations', { accountId: account.id })
              .catch(() => undefined);
          }
        }

        if (due(GBP_SYNC_INTERVALS.reviews, schedulerKey(connectionId, 'reviews'))) {
          const locations = await prisma.googleBusinessLocation.findMany({
            where: { workspaceId, connectionId },
            select: { id: true },
          });
          for (const loc of locations) {
            await googleBusinessSyncService
              .enqueue(workspaceId, connectionId, 'reviews', { locationId: loc.id })
              .catch(() => undefined);
          }
        }

        if (due(GBP_SYNC_INTERVALS.metrics, schedulerKey(connectionId, 'metrics'))) {
          const locations = await prisma.googleBusinessLocation.findMany({
            where: { workspaceId, connectionId },
            select: { id: true },
          });
          for (const loc of locations) {
            await googleBusinessSyncService
              .enqueue(workspaceId, connectionId, 'metrics', { locationId: loc.id })
              .catch(() => undefined);
          }
        }
      }
    } catch (err) {
      console.error('GBP scheduler tick failed', err);
    }
  };

  const timer = setInterval(() => void tick(), GBP_SYNC_INTERVALS.schedulerTick);
  void tick();
  console.log('GBP auto-sync scheduler started');
  return timer;
}
