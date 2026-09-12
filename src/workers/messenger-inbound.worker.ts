import { Worker } from 'bullmq';
import { config } from '../config.js';
import { withJobSpan } from '../lib/otel-job.js';
import {
  MESSENGER_INBOUND_QUEUE,
  type MessengerInboundJobData,
} from '../queue/messenger-inbound.queue.js';
import { processMessengerInboundWebhook } from '../services/messengerInboundWebhook.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startMessengerInboundWorker() {
  const worker = new Worker<MessengerInboundJobData>(
    MESSENGER_INBOUND_QUEUE,
    async (job) => {
      return withJobSpan(
        'queue.messenger-inbound',
        { jobId: String(job.id ?? '') },
        () => processMessengerInboundWebhook(job.data.body)
      );
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('[messenger-inbound] worker failed', job?.id, err);
  });

  return worker;
}
