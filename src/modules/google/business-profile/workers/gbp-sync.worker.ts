import { Worker } from 'bullmq';
import { config } from '../../../../config.js';
import { GBP_SYNC_QUEUE } from '../queue/gbp-sync.queue.js';
import type { GbpSyncJobData } from '../queue/gbp-sync.queue.js';
import { googleBusinessSyncService } from '../services/google-business-sync.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startGbpSyncWorker() {
  const worker = new Worker<GbpSyncJobData>(
    GBP_SYNC_QUEUE,
    async (job) => {
      await googleBusinessSyncService.runJob(job.data);
    },
    { connection, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    console.error('GBP sync worker failed', job?.name, job?.id, err);
  });

  console.log('GBP sync worker started (concurrency: 1)');
  return worker;
}
