import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from './lib/prisma.js';
import {
  backfillWorkspaceUsageLimitsFromPlans,
  detachPlansFromTrialWorkspaces,
  seedSubscriptionPlans,
} from './services/subscriptionPlans.js';
import { backfillWorkspaceTrials } from './services/trial.js';

const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'admin@convosync.io').toLowerCase();
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'convosync@admin1';
const SUPER_ADMIN_NAME = process.env.SUPER_ADMIN_NAME || 'ConvoSync Super Admin';

async function main() {
  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 12);

  const admin = await prisma.platformAdmin.upsert({
    where: { email: SUPER_ADMIN_EMAIL },
    create: {
      email: SUPER_ADMIN_EMAIL,
      name: SUPER_ADMIN_NAME,
      password: passwordHash,
      role: 'super_admin',
    },
    update: {
      name: SUPER_ADMIN_NAME,
      password: passwordHash,
      role: 'super_admin',
    },
  });

  const plans = await seedSubscriptionPlans();
  const detached = await detachPlansFromTrialWorkspaces();
  const backfilled = await backfillWorkspaceTrials();
  const usageLimitsBackfilled = await backfillWorkspaceUsageLimitsFromPlans();

  console.log(`Platform admin ready: ${admin.email}`);
  if (detached > 0) {
    console.log(`Cleared plan from ${detached} trial workspace(s)`);
  }
  if (backfilled > 0) {
    console.log(`Backfilled trial dates for ${backfilled} workspace(s)`);
  }
  if (usageLimitsBackfilled > 0) {
    console.log(`Synced usage limits (incl. emails) for ${usageLimitsBackfilled} workspace(s)`);
  }
  console.log(`Subscription plans ready: ${plans.map((p) => p.name).join(', ')}`);
  console.log('Use these credentials on the super-admin login page.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
