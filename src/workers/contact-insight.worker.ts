import { Worker } from 'bullmq';
import { config } from '../config.js';
import {
  CONTACT_INSIGHT_QUEUE,
  type ContactInsightJobData,
} from '../queue/contact-insight.queue.js';
import { computeContactInsight } from '../modules/contact-insight/contact-insight.service.js';
import { withJobSpan } from '../lib/otel-job.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startContactInsightWorker() {
  if (!config.contactInsight.enabled) {
    console.log('[contact-insight] worker skipped (CONTACT_INSIGHT_ENABLED=false)');
    return null;
  }

  const worker = new Worker<ContactInsightJobData>(
    CONTACT_INSIGHT_QUEUE,
    async (job) => {
      return withJobSpan(
        'queue.contact-insight-compute',
        {
          contactId: job.data.contactId,
          workspaceId: job.data.workspaceId,
          reason: job.data.reason,
          jobId: String(job.id ?? ''),
        },
        async () => {
          const result = await computeContactInsight(job.data);
          console.log(
            '[contact-insight]',
            result.status,
            job.data.contactId,
            result.status === 'created' ? result.insightId : result.reason,
            `reason=${job.data.reason}`
          );
          return result;
        }
      );
    },
    { connection, concurrency: 2 }
  );

  worker.on('failed', (job, err) => {
    console.error('[contact-insight] worker failed', job?.id, err);
  });

  return worker;
}
