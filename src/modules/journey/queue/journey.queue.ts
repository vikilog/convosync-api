import { Queue } from 'bullmq';
import { config } from '../../../config.js';
import type { DelayJobData } from '../types/journey.types.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export const JOURNEY_DELAY_QUEUE = 'journey-delay';

let delayQueue: Queue<DelayJobData> | null = null;

export function getJourneyDelayQueue(): Queue<DelayJobData> {
  if (!delayQueue) {
    delayQueue = new Queue<DelayJobData>(JOURNEY_DELAY_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return delayQueue;
}

export function delayMs(amount: number, unit: 'minutes' | 'hours' | 'days'): number {
  const multipliers = {
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
  } as const;
  return Math.max(0, amount) * multipliers[unit];
}

export async function scheduleJourneyDelay(
  data: DelayJobData,
  waitMs: number
): Promise<string> {
  const job = await getJourneyDelayQueue().add('resume', data, { delay: waitMs });
  return job.id ?? '';
}
