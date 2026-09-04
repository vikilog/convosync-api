/**
 * Poll BullMQ queue depths → OTel ObservableGauges (queue.waiting / active / …).
 */
import { Queue } from 'bullmq';
import { config } from '../config.js';
import { setQueueDepths } from './otel-metrics.js';

const QUEUE_NAMES = [
  'campaign-broadcast',
  'contact-insight-compute',
  'call-transcript',
  'journey-delay',
  'gbp-sync',
] as const;

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

let started = false;

export function startQueueDepthPoller(intervalMs = 30_000): void {
  if (started) return;
  started = true;

  const queues = QUEUE_NAMES.map(
    (name) => new Queue(name, { connection })
  );

  const tick = async () => {
    await Promise.all(
      queues.map(async (q) => {
        try {
          const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
          setQueueDepths(q.name, {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          });
        } catch (err) {
          console.warn('[otel] queue depth poll failed', q.name, err);
        }
      })
    );
  };

  void tick();
  setInterval(() => void tick(), intervalMs);
}
