import { prisma } from '../index.js';

// The send loop touches Campaign.updatedAt every CAMPAIGN_PROGRESS_CHECK_INTERVAL
// contacts (a few seconds apart under normal send latency) — a campaign that
// hasn't been touched in this long is a crashed/killed worker, not a slow one.
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Finds campaigns stuck in 'running' with no progress touch for longer than
 * STUCK_THRESHOLD_MS (a worker crashed or was killed mid-send) and marks them
 * 'failed' so they become resendable again via the normal /send flow, instead
 * of staying permanently stuck with no recovery path.
 */
export async function reapStuckCampaigns(): Promise<number> {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const stuck = await prisma.campaign.findMany({
    where: { status: 'running', updatedAt: { lt: threshold } },
    select: { id: true, workspaceId: true, name: true },
  });

  let reaped = 0;
  for (const campaign of stuck) {
    // Re-check status+updatedAt in the write itself — a campaign that
    // progressed between the read above and now must not be touched.
    const result = await prisma.campaign.updateMany({
      where: { id: campaign.id, status: 'running', updatedAt: { lt: threshold } },
      data: { status: 'failed' },
    });
    if (result.count > 0) {
      reaped += 1;
      console.warn('[campaign-reaper] marked stuck campaign as failed', {
        campaignId: campaign.id,
        workspaceId: campaign.workspaceId,
        name: campaign.name,
      });
    }
  }
  return reaped;
}
