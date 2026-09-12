import { Queue } from 'bullmq';
import { config } from '../config.js';

export const INSTAGRAM_INBOUND_QUEUE = 'instagram-inbound';

type InstagramInboundEvent = {
  timestamp?: number;
  message?: { mid?: string };
  postback?: { mid?: string };
  read?: { mid?: string; watermark?: number };
  delivery?: { mids?: string[]; watermark?: number };
};

export type InstagramInboundWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
    messaging?: InstagramInboundEvent[];
    standby?: InstagramInboundEvent[];
  }>;
};

export type InstagramInboundJobData = {
  body: InstagramInboundWebhookBody;
};

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

let queue: Queue<InstagramInboundJobData> | null = null;

export function getInstagramInboundQueue(): Queue<InstagramInboundJobData> {
  if (!queue) {
    queue = new Queue<InstagramInboundJobData>(INSTAGRAM_INBOUND_QUEUE, {
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

/**
 * Stable BullMQ jobId (no `:`). Coalesces Meta retries of the same delivery.
 * Read/delivery reuse one mid — include status (+ timestamp) so later
 * receipts still enqueue after the first completes.
 */
export function instagramInboundJobId(body: InstagramInboundWebhookBody): string {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = (change?.value ?? {}) as Record<string, unknown>;
  const ev = entry?.messaging?.[0] ?? entry?.standby?.[0];
  const readId = ev?.read?.mid ?? (ev?.read?.watermark != null ? String(ev.read.watermark) : '');
  const deliveryId =
    ev?.delivery?.mids?.[0] ?? (ev?.delivery?.watermark != null ? String(ev.delivery.watermark) : '');
  const statusKey = readId
    ? [readId, 'read', ev?.timestamp].filter((p) => p != null && String(p) !== '').join('-')
    : deliveryId
      ? [deliveryId, 'delivered', ev?.timestamp].filter((p) => p != null && String(p) !== '').join('-')
      : '';
  const raw =
    ev?.message?.mid ||
    ev?.postback?.mid ||
    statusKey ||
    (typeof value.comment_id === 'string' && value.comment_id) ||
    (typeof value.id === 'string' && value.id) ||
    (typeof entry?.id === 'string' && entry.id
      ? `${entry.id}-${typeof change?.field === 'string' ? change.field : body.object ?? 'webhook'}`
      : '');
  const safe = String(raw).replace(/:/g, '-').slice(0, 200);
  return safe ? `ig-inbound-${safe}` : 'ig-inbound-unknown';
}

export async function enqueueInstagramInbound(body: InstagramInboundWebhookBody): Promise<string> {
  const q = getInstagramInboundQueue();
  const jobId = instagramInboundJobId(body);
  try {
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed' || state === 'completed') {
        return jobId;
      }
      if (state === 'failed') {
        await existing.remove();
      }
    }
  } catch {
    /* ignore getJob/remove races */
  }
  const job = await q.add('process', { body }, { jobId });
  return job.id ?? jobId;
}
