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

/** Must be more than this far before send to edit a scheduled campaign. */
export const SCHEDULED_CAMPAIGN_EDIT_LEAD_MS = 10 * 60 * 1000;

/** Delay until scheduledAt (ms). Past / invalid → 0. */
export function campaignScheduleDelayMs(scheduledAt: Date | string | null | undefined): number {
  if (!scheduledAt) return 0;
  const t = scheduledAt instanceof Date ? scheduledAt.getTime() : new Date(scheduledAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - Date.now());
}

/**
 * 'draft' — always editable (never sent, no in-flight job to race).
 * 'scheduled' — only more than 10 minutes before its own send time.
 * Anything else (running/completed/failed/cancelled) — not editable here.
 */
export function isScheduledCampaignEditable(
  status: string | null | undefined,
  scheduledAt: Date | string | null | undefined,
  now = Date.now()
): boolean {
  const s = (status ?? '').toLowerCase();
  if (s === 'draft') return true;
  if (s !== 'scheduled') return false;
  if (!scheduledAt) return false;
  const t = scheduledAt instanceof Date ? scheduledAt.getTime() : new Date(scheduledAt).getTime();
  if (!Number.isFinite(t)) return false;
  return t - now > SCHEDULED_CAMPAIGN_EDIT_LEAD_MS;
}

export async function enqueueCampaignBroadcast(
  data: CampaignBroadcastJobData,
  delayMs = 0
): Promise<string> {
  const q = getCampaignBroadcastQueue();
  // BullMQ custom jobId cannot contain `:`.
  const jobId = `campaign-broadcast-${data.campaignId}`;
  // One pending job per campaign — reschedule replaces delayed/waiting.
  try {
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active') {
        throw new Error('Campaign broadcast already running');
      }
      if (state === 'delayed' || state === 'waiting' || state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Campaign broadcast already running') throw err;
    /* ignore getJob/remove races */
  }

  const job = await q.add('broadcast', data, {
    delay: Math.max(0, delayMs),
    jobId,
  });
  return job.id ?? '';
}

/** Removes a not-yet-started scheduled job (cancel before it fires). No-op if already active/gone. */
export async function cancelScheduledCampaignBroadcast(campaignId: string): Promise<void> {
  const q = getCampaignBroadcastQueue();
  const jobId = `campaign-broadcast-${campaignId}`;
  try {
    const existing = await q.getJob(jobId);
    if (!existing) return;
    const state = await existing.getState();
    if (state === 'delayed' || state === 'waiting') {
      await existing.remove();
    }
  } catch {
    /* ignore getJob/remove races */
  }
}
