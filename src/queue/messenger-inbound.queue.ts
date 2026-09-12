import { Queue } from 'bullmq';
import { config } from '../config.js';

export const MESSENGER_INBOUND_QUEUE = 'messenger-inbound';

export type MessengerInboundWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
    messaging?: Array<{ message?: { mid?: string }; postback?: { mid?: string } }>;
  }>;
};

export type MessengerInboundJobData = {
  body: MessengerInboundWebhookBody;
};

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

let queue: Queue<MessengerInboundJobData> | null = null;

export function getMessengerInboundQueue(): Queue<MessengerInboundJobData> {
  if (!queue) {
    queue = new Queue<MessengerInboundJobData>(MESSENGER_INBOUND_QUEUE, {
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

/** Stable BullMQ jobId (no `:`). Coalesces Meta retries of the same delivery. */
export function messengerInboundJobId(body: MessengerInboundWebhookBody): string {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = (change?.value ?? {}) as Record<string, unknown>;
  const raw =
    entry?.messaging?.[0]?.message?.mid ||
    entry?.messaging?.[0]?.postback?.mid ||
    (typeof value.comment_id === 'string' && value.comment_id) ||
    (typeof value.id === 'string' && value.id) ||
    (typeof entry?.id === 'string' && entry.id
      ? `${entry.id}-${typeof change?.field === 'string' ? change.field : body.object ?? 'webhook'}`
      : '');
  const safe = String(raw).replace(/:/g, '-').slice(0, 200);
  return safe ? `msgr-inbound-${safe}` : 'msgr-inbound-unknown';
}

export async function enqueueMessengerInbound(body: MessengerInboundWebhookBody): Promise<string> {
  const q = getMessengerInboundQueue();
  const jobId = messengerInboundJobId(body);
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
