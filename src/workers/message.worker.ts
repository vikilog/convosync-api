import { Worker } from 'bullmq';
import { config } from '../config.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startMessageWorker() {
  const worker = new Worker(
    'outbound-messages',
    async (job) => {
      console.log('Processing outbound message job', job.id, job.data);
    },
    { connection }
  );

  return worker;
}
