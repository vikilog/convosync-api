/**
 * Relaunches every currently-'failed' email campaign, staggering their send
 * times evenly across the next 30 minutes (instead of firing them all at
 * once) so an email provider isn't hit with a simultaneous burst.
 *
 * Reuses the exact same path a normal scheduled campaign takes:
 * flips the campaign to 'scheduled' with the new time and enqueues it on the
 * 'campaign-broadcast' queue — the already-running backend's campaign worker
 * (src/workers/campaign.worker.ts) picks it up and sends it for real. The
 * backend process must be running for anything to actually send; this
 * script only queues the jobs.
 *
 * Safe to re-run: enqueueCampaignBroadcast replaces any existing
 * delayed/waiting job for the same campaignId rather than duplicating it.
 *
 * Run: npx tsx scripts/relaunch-failed-email-campaigns.ts
 */
import { prisma } from '../src/lib/prisma.js';
import {
  campaignScheduleDelayMs,
  enqueueCampaignBroadcast,
  getCampaignBroadcastQueue,
} from '../src/queue/campaign-broadcast.queue.js';

const WINDOW_MS = 30 * 60 * 1000;

export async function relaunchFailedEmailCampaigns(): Promise<{
  found: number;
  enqueued: number;
  failed: number;
}> {
  const candidates = await prisma.campaign.findMany({
    where: { status: 'failed' },
    select: { id: true, name: true, workspaceId: true, audienceFilter: true },
    orderBy: { updatedAt: 'asc' },
  });

  const campaigns = candidates.filter((c) => {
    const filter = c.audienceFilter as { channel?: string } | null;
    return filter?.channel === 'email';
  });

  console.log(`Found ${candidates.length} failed campaigns, ${campaigns.length} are email.`);
  if (campaigns.length === 0) {
    return { found: 0, enqueued: 0, failed: 0 };
  }

  const spacingMs = Math.floor(WINDOW_MS / campaigns.length);
  let enqueued = 0;
  let failed = 0;

  for (let i = 0; i < campaigns.length; i++) {
    const c = campaigns[i]!;
    const scheduledAt = new Date(Date.now() + i * spacingMs);

    try {
      await prisma.campaign.update({
        where: { id: c.id },
        data: { status: 'scheduled', scheduledAt, lastError: null },
      });
      await enqueueCampaignBroadcast(
        { campaignId: c.id, workspaceId: c.workspaceId },
        campaignScheduleDelayMs(scheduledAt)
      );
      enqueued += 1;
      console.log(`OK   ${c.name} -> ${scheduledAt.toISOString()}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${c.name}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone. ${enqueued} enqueued, ${failed} failed, all within the next 30 minutes.`);
  return { found: campaigns.length, enqueued, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  relaunchFailedEmailCampaigns()
    .then(async () => {
      await getCampaignBroadcastQueue().close();
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
