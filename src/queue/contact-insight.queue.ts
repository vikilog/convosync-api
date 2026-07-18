import { Queue } from 'bullmq';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { canComputeInsightNow } from '../modules/contact-insight/contact-insight.service.js';
import type { ContactInsightJobData } from '../modules/contact-insight/contact-insight.types.js';

export type { ContactInsightJobData };
export const CONTACT_INSIGHT_QUEUE = 'contact-insight-compute';

let queue: Queue<ContactInsightJobData> | null = null;

export function getContactInsightQueue(): Queue<ContactInsightJobData> {
  if (!queue) {
    queue = new Queue<ContactInsightJobData>(CONTACT_INSIGHT_QUEUE, {
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }
  return queue;
}

function jobIdFor(contactId: string, force?: boolean) {
  // Force manual runs get a unique id so they aren't blocked by a completed auto jobId
  return force
    ? `contact-insight-${contactId}-manual-${Date.now()}`
    : `contact-insight-${contactId}`;
}

/**
 * Enqueue (or coalesce) insight compute for a contact.
 * Respects min-gap unless force=true (manual prepare from UI).
 */
export async function enqueueContactInsight(
  data: ContactInsightJobData
): Promise<{ queued: boolean; reason?: string; jobId?: string }> {
  if (!config.contactInsight.enabled) {
    return { queued: false, reason: 'disabled' };
  }

  const contact = await prisma.contact.findFirst({
    where: { id: data.contactId, workspaceId: data.workspaceId },
    select: { id: true, excludeFromInsights: true },
  });
  if (!contact) return { queued: false, reason: 'contact_not_found' };
  if (contact.excludeFromInsights) {
    return { queued: false, reason: 'excluded' };
  }

  const force = Boolean(data.force);
  const gap = await canComputeInsightNow(data.contactId);
  const delay = force || gap.ok ? 0 : Math.max(gap.retryAfterMs ?? 0, 0);

  const q = getContactInsightQueue();
  const jobId = jobIdFor(data.contactId, force);

  if (!force) {
    try {
      const existing = await q.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'waiting' || state === 'delayed' || state === 'active') {
          return { queued: false, reason: `coalesced:${state}`, jobId };
        }
        if (state === 'completed' || state === 'failed') {
          await existing.remove();
        }
      }
    } catch {
      /* ignore */
    }
  }

  await q.add('compute', { ...data, force }, {
    jobId,
    delay: delay > 0 ? delay : undefined,
  });

  return {
    queued: true,
    reason: delay > 0 ? `delayed:${Math.round(delay / 1000)}s` : force ? 'manual' : 'immediate',
    jobId,
  };
}
