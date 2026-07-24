import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildTrialWindow, DEFAULT_TRIAL_DAYS } from './services/trial.js';

const prisma = new PrismaClient();

/** Tables to preserve — users, company profile, memberships, and platform catalog/config. */
const KEEP_TABLES = new Set([
  'User',
  'Workspace',
  'WorkspaceMembership',
  'subscription_plans',
  'PlatformAdmin',
  'platform_config',
  'platform_message_templates',
]);

async function main() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `;

  const toTruncate = rows
    .map((r) => r.tablename)
    .filter((name) => !KEEP_TABLES.has(name));

  if (toTruncate.length === 0) {
    console.log('No tables to truncate.');
  } else {
    const quoted = toTruncate.map((t) => `"${t}"`).join(',\n      ');
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        ${quoted}
      RESTART IDENTITY CASCADE;
    `);
    console.log(`Truncated ${toTruncate.length} tables.`);
  }

  // Reset workspace operational state while keeping company profile fields.
  // Super-admin tenants stay active; customer workspaces go back on a fresh 14-day trial.
  const now = new Date();
  const { trialStartedAt, trialEndsAt } = buildTrialWindow(now, DEFAULT_TRIAL_DAYS);

  const customerReset = await prisma.workspace.updateMany({
    where: { isSuperAdmin: false },
    data: {
      planId: null,
      planTier: 'FREE',
      subscriptionStatus: 'trial',
      trialStartedAt,
      trialEndsAt,
      customPlanSelection: Prisma.DbNull,
      waNumberId: null,
      waToken: null,
      wabaId: null,
      waPhoneNumber: null,
      fbPageId: null,
      fbPageToken: null,
      fbPageName: null,
      metaAdAccountId: null,
      metaUserToken: null,
      emailIntegrationEnabled: false,
    },
  });

  const users = await prisma.user.count();
  const workspaces = await prisma.workspace.count();

  console.log(`Kept ${users} user(s), ${workspaces} workspace(s), company info intact.`);
  console.log(`Reset operational fields on ${customerReset.count} customer workspace(s) → 14-day trial.`);
  console.log('Ready for fresh testing from scratch.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
