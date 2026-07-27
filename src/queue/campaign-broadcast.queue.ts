import { Queue } from 'bullmq';
import { config } from '../config.js';

export const CAMPAIGN_BROADCAST_QUEUE = 'campaign-broadcast';

export type CampaignBroadcastJobData = {
  campaignId: string;
  workspaceId: string;
};

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

let queue: Queue<CampaignBroadcastJobData> | null = null;

export function getCampaignBroadcastQueue(): Queue<CampaignBroadcastJobData> {
  if (!queue) {
    queue = new Queue<CampaignBroadcastJobData>(CAMPAIGN_BROADCAST_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return queue;
}

/** Delay until scheduledAt (ms). Past / invalid → 0. */
export function campaignScheduleDelayMs(scheduledAt: Date | string | null | undefined): number {
  if (!scheduledAt) return 0;
  const t = scheduledAt instanceof Date ? scheduledAt.getTime() : new Date(scheduledAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - Date.now());
}

export async function enqueueCampaignBroadcast(
  data: CampaignBroadcastJobData,
  delayMs = 0
): Promise<string> {
  const job = await getCampaignBroadcastQueue().add('broadcast', data, {
    delay: Math.max(0, delayMs),
    // One pending job per campaign — reschedule replaces.
    // BullMQ custom jobId cannot contain `:`.
    jobId: `campaign-broadcast-${data.campaignId}`,
  });
  return job.id ?? '';
}
