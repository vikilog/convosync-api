import { Worker } from 'bullmq';
import { config } from '../../../config.js';
import { prisma } from '../../../index.js';
import { getInstagramJourneyContainer } from '../container.js';
import { IG_JOURNEY_DELAY_QUEUE } from '../queue/ig-journey.queue.js';
import type { IgDelayJobData } from '../types/ig-journey.types.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startIgJourneyWorker() {
  const { engine } = getInstagramJourneyContainer(prisma);

  const worker = new Worker<IgDelayJobData>(
    IG_JOURNEY_DELAY_QUEUE,
    async (job) => {
      const { executionId, nextNodeId } = job.data;
      await engine.continueAfterDelay(executionId, nextNodeId);
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('Instagram journey delay worker failed', job?.id, err);
  });

  console.log('Instagram journey delay worker started');
  return worker;
}
