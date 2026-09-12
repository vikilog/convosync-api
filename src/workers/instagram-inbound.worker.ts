import { Worker } from 'bullmq';
import { config } from '../config.js';
import { withJobSpan } from '../lib/otel-job.js';
import {
  INSTAGRAM_INBOUND_QUEUE,
  type InstagramInboundJobData,
} from '../queue/instagram-inbound.queue.js';
import { processInstagramInboundWebhook } from '../services/instagramInboundWebhook.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startInstagramInboundWorker() {
  const worker = new Worker<InstagramInboundJobData>(
    INSTAGRAM_INBOUND_QUEUE,
    async (job) => {
      return withJobSpan(
        'queue.instagram-inbound',
        { jobId: String(job.id ?? '') },
        () => processInstagramInboundWebhook(job.data.body)
      );
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('[instagram-inbound] worker failed', job?.id, err);
  });

  return worker;
}
