import { Queue } from 'bullmq';
import { config } from '../config.js';

export const WHATSAPP_INBOUND_QUEUE = 'whatsapp-inbound';

export type WhatsAppInboundWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
    messaging?: Array<{ message?: { mid?: string } }>;
  }>;
};

export type WhatsAppInboundJobData = {
  body: WhatsAppInboundWebhookBody;
};

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

let queue: Queue<WhatsAppInboundJobData> | null = null;

export function getWhatsAppInboundQueue(): Queue<WhatsAppInboundJobData> {
  if (!queue) {
    queue = new Queue<WhatsAppInboundJobData>(WHATSAPP_INBOUND_QUEUE, {
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
 * Status webhooks reuse one wamid for sent → delivered → read — include status
 * (+ timestamp) so later receipts still enqueue after the first completes.
 */
export function whatsappInboundJobId(body: WhatsAppInboundWebhookBody): string {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = (change?.value ?? {}) as Record<string, unknown>;
  const messages = value.messages as Array<{ id?: string }> | undefined;
  const statuses = value.statuses as
    | Array<{ id?: string; status?: string; timestamp?: string }>
    | undefined;
  const echoes = value.message_echoes as Array<{ id?: string }> | undefined;
  const st = statuses?.[0];
  const statusKey = st?.id
    ? [st.id, st.status, st.timestamp].filter((p) => p != null && String(p) !== '').join('-')
    : '';
  const raw =
    messages?.[0]?.id ||
    statusKey ||
    echoes?.[0]?.id ||
    entry?.messaging?.[0]?.message?.mid ||
    (typeof entry?.id === 'string' && entry.id
      ? `${entry.id}-${typeof change?.field === 'string' ? change.field : body.object ?? 'webhook'}`
      : '');
  const safe = String(raw).replace(/:/g, '-').slice(0, 200);
  return safe ? `wa-inbound-${safe}` : 'wa-inbound-unknown';
}

export async function enqueueWhatsAppInbound(body: WhatsAppInboundWebhookBody): Promise<string> {
  const q = getWhatsAppInboundQueue();
  const jobId = whatsappInboundJobId(body);
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
