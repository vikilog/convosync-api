import { Worker } from 'bullmq';
import { config } from '../../../config.js';
import { prisma } from '../../../index.js';
import { getJourneyContainer } from '../container.js';
import { JOURNEY_DELAY_QUEUE } from '../queue/journey.queue.js';
import type { DelayJobData } from '../types/journey.types.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startJourneyWorker() {
  const { engine } = getJourneyContainer(prisma);

  const worker = new Worker<DelayJobData>(
    JOURNEY_DELAY_QUEUE,
    async (job) => {
      const { executionId, nextNodeId } = job.data;
      await engine.continueAfterDelay(executionId, nextNodeId);
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('Journey delay worker failed', job?.id, err);
  });

  console.log('Journey delay worker started');
  return worker;
}
