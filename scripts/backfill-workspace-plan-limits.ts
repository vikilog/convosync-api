/**
 * One-time / ops: re-sync WorkspaceUsageLimits from each workspace's SubscriptionPlan.features.
 * Reuses syncWorkspaceLimitsFromPlanFeatures (same helper as admin assign + Razorpay verify).
 *
 * Who needs it: workspaces with planId set (esp. admin-assigned Growth/Business) whose
 * usageLimits.channelsLimit (or seats/agents) may be stale from before sync was wired.
 * Channel *type* entitlements (Instagram/Messenger) read plan.features via planId — not
 * this table — but re-running is harmless and keeps numeric caps in sync.
 *
 * Run from backend/:
 *   npx tsx scripts/backfill-workspace-plan-limits.ts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { backfillWorkspaceUsageLimitsFromPlans } from '../src/services/subscriptionPlans.js';

async function main() {
  const withPlan = await prisma.workspace.count({ where: { planId: { not: null } } });
  const bySlug = await prisma.workspace.groupBy({
    by: ['planId'],
    where: { planId: { not: null } },
    _count: true,
  });
  const plans = await prisma.subscriptionPlan.findMany({
    where: { id: { in: bySlug.map((r) => r.planId!).filter(Boolean) } },
    select: { id: true, slug: true, name: true },
  });
  const planById = new Map(plans.map((p) => [p.id, p]));

  console.log(`Workspaces with planId: ${withPlan}`);
  for (const row of bySlug) {
    const plan = row.planId ? planById.get(row.planId) : null;
    console.log(`  ${plan?.slug ?? row.planId}: ${row._count}`);
  }

  const updated = await backfillWorkspaceUsageLimitsFromPlans();
  console.log(`Synced WorkspaceUsageLimits for ${updated} workspace(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
