import { Worker } from 'bullmq';
import { config } from '../config.js';
import { withJobSpan } from '../lib/otel-job.js';
import {
  WHATSAPP_INBOUND_QUEUE,
  type WhatsAppInboundJobData,
} from '../queue/whatsapp-inbound.queue.js';
import { processWhatsAppInboundWebhook } from '../services/whatsappInboundWebhook.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startWhatsAppInboundWorker() {
  const worker = new Worker<WhatsAppInboundJobData>(
    WHATSAPP_INBOUND_QUEUE,
    async (job) => {
      return withJobSpan(
        'queue.whatsapp-inbound',
        { jobId: String(job.id ?? '') },
        () => processWhatsAppInboundWebhook(job.data.body)
      );
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('[whatsapp-inbound] worker failed', job?.id, err);
  });

  return worker;
}
