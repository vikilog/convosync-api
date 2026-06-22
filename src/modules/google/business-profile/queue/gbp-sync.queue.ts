import { Queue } from 'bullmq';
import type { GoogleBusinessSyncType } from '@prisma/client';
import { config } from '../../../../config.js';

export const GBP_SYNC_QUEUE = 'gbp-sync';

export type GbpSyncJobData = {
  workspaceId: string;
  connectionId: string;
  syncType: GoogleBusinessSyncType;
  accountId?: string;
  locationId?: string;
  force?: boolean;
};

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

let queue: Queue<GbpSyncJobData> | null = null;

export function getGbpSyncQueue(): Queue<GbpSyncJobData> {
  if (!queue) {
    queue = new Queue<GbpSyncJobData>(GBP_SYNC_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    });
  }
  return queue;
}
