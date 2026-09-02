/**
 * Re-creates BullMQ jobs for every 'scheduled' campaign in the shared
 * database, targeting whichever Redis THIS process's REDIS_URL points at.
 *
 * Why this is needed: the database is shared between local dev and live,
 * but Redis is not. Campaigns created (and enqueued) while running against
 * local Redis have a real 'scheduled' row in the shared DB, but no job in
 * live Redis — so live's worker never saw them and they silently never
 * fired. Running this ON the live server (with the live REDIS_URL) creates
 * the missing job in the queue the live worker actually reads.
 *
 * Any campaign whose original scheduledAt has already passed is bumped
 * forward to the next occurrence of FALLBACK_HOUR_IST before being
 * enqueued, so it doesn't fire immediately on resync. Campaigns whose
 * scheduledAt is still ahead keep their original time — they just get
 * (re-)enqueued.
 *
 * Safe to re-run: enqueueCampaignBroadcast replaces any existing
 * delayed/waiting job for the same campaignId rather than duplicating it.
 *
 * Run: npx tsx scripts/resync-scheduled-campaigns-to-redis.ts
 */
import { prisma } from '../src/lib/prisma.js';
import {
  campaignScheduleDelayMs,
  enqueueCampaignBroadcast,
  getCampaignBroadcastQueue,
} from '../src/queue/campaign-broadcast.queue.js';

const WORKSPACE_ID = 'cmrxuhnwg0000p974mztbf08j'; // ConvoSync workspace
const FALLBACK_HOUR_IST = 2; // campaigns whose time already passed get pushed to the next 2 AM IST
const IST_OFFSET_MIN = 5 * 60 + 30;

/** Next occurrence of `hour` (0-23) in IST, as a real UTC Date. */
function nextIstHour(hour: number): Date {
  const nowIstMs = Date.now() + IST_OFFSET_MIN * 60_000;
  const nowIst = new Date(nowIstMs);
  const targetIstMs = Date.UTC(
    nowIst.getUTCFullYear(),
    nowIst.getUTCMonth(),
    nowIst.getUTCDate(),
    hour,
    0,
    0
  );
  const adjustedIstMs = targetIstMs <= nowIstMs ? targetIstMs + 24 * 60 * 60_000 : targetIstMs;
  return new Date(adjustedIstMs - IST_OFFSET_MIN * 60_000);
}

export async function resyncScheduledCampaignsToRedis(): Promise<{
  found: number;
  bumped: number;
  enqueued: number;
  failed: number;
}> {
  const campaigns = await prisma.campaign.findMany({
    where: { workspaceId: WORKSPACE_ID, status: 'scheduled' },
    select: { id: true, name: true, scheduledAt: true, workspaceId: true },
    orderBy: { scheduledAt: 'asc' },
  });

  console.log(`Found ${campaigns.length} scheduled campaigns.`);

  let bumped = 0;
  let enqueued = 0;
  let failed = 0;

  for (const c of campaigns) {
    let scheduledAt = c.scheduledAt;
    const alreadyPast = !scheduledAt || campaignScheduleDelayMs(scheduledAt) <= 0;

    if (alreadyPast) {
      scheduledAt = nextIstHour(FALLBACK_HOUR_IST);
      await prisma.campaign.update({ where: { id: c.id }, data: { scheduledAt } });
      bumped += 1;
    }

    try {
      await enqueueCampaignBroadcast(
        { campaignId: c.id, workspaceId: c.workspaceId },
        campaignScheduleDelayMs(scheduledAt as Date)
      );
      enqueued += 1;
      console.log(
        `OK   ${c.name} -> ${(scheduledAt as Date).toISOString()}${alreadyPast ? ' (bumped from a passed time)' : ''}`
      );
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${c.name}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone. ${enqueued} enqueued, ${bumped} time-bumped, ${failed} failed.`);
  return { found: campaigns.length, bumped, enqueued, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resyncScheduledCampaignsToRedis()
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
