import { Queue } from 'bullmq';
import { config } from '../../../config.js';
import type { IgDelayJobData } from '../types/ig-journey.types.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export const IG_JOURNEY_DELAY_QUEUE = 'instagram-journey-delay';

let delayQueue: Queue<IgDelayJobData> | null = null;

export function getIgJourneyDelayQueue(): Queue<IgDelayJobData> {
  if (!delayQueue) {
    delayQueue = new Queue<IgDelayJobData>(IG_JOURNEY_DELAY_QUEUE, {
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

export function igDelayMs(amount: number, unit: 'minutes' | 'hours' | 'days'): number {
  const multipliers = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
  return Math.max(0, amount) * multipliers[unit];
}

export async function scheduleIgJourneyDelay(
  data: IgDelayJobData,
  waitMs: number
): Promise<string> {
  const job = await getIgJourneyDelayQueue().add('resume', data, { delay: waitMs });
  return job.id ?? '';
}
