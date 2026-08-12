import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';

const SUPER_ADMIN_SLUG = 'convosync';
const SUPER_ADMIN_WORKSPACE_NAME = 'ConvoSync';
const SUPER_ADMIN_USER_NAME = process.env.SUPER_ADMIN_NAME?.trim() || 'ConvoSync Admin';
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'admin@convosync.io').toLowerCase();
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Admin@123';

/** Highest workspace role in ConvoSync (User.role + WorkspaceMembership.role). */
const SUPER_ADMIN_ROLE = 'admin';

const REQUIRED_ENV_VARS = [
  'SUPER_ADMIN_WABA_ID',
  'SUPER_ADMIN_PHONE_NUMBER_ID',
  'SUPER_ADMIN_ACCESS_TOKEN',
  'SUPER_ADMIN_IG_ACCOUNT_ID',
  'SUPER_ADMIN_IG_ACCESS_TOKEN',
  'SUPER_ADMIN_FB_PAGE_ID',
] as const;

type SuperAdminEnv = {
  wabaId: string;
  phoneNumberId: string;
  whatsappAccessToken: string;
  instagramAccountId: string;
  instagramAccessToken: string;
  facebookPageId: string;
};

function requireEnv(name: (typeof REQUIRED_ENV_VARS)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See backend/.env.example for where to find this value.`
    );
  }
  return value;
}

function loadSuperAdminEnv(): SuperAdminEnv {
  return {
    wabaId: requireEnv('SUPER_ADMIN_WABA_ID'),
    phoneNumberId: requireEnv('SUPER_ADMIN_PHONE_NUMBER_ID'),
    whatsappAccessToken: requireEnv('SUPER_ADMIN_ACCESS_TOKEN'),
    instagramAccountId: requireEnv('SUPER_ADMIN_IG_ACCOUNT_ID'),
    instagramAccessToken: requireEnv('SUPER_ADMIN_IG_ACCESS_TOKEN'),
    facebookPageId: requireEnv('SUPER_ADMIN_FB_PAGE_ID'),
  };
}

/** WA is connected when workspace Graph creds + at least one phone account exist. */
async function ensureWhatsAppConnection(
  workspaceId: string,
  env: SuperAdminEnv,
  mode: 'connect' | 'reconnect'
): Promise<'skipped' | 'connected' | 'reconnected'> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: {
      waNumberId: true,
      wabaId: true,
      waToken: true,
      _count: { select: { whatsappPhoneAccounts: true } },
    },
  });

  const hasCreds = Boolean(workspace.waNumberId && workspace.wabaId && workspace.waToken);
  const hasAccount = workspace._count.whatsappPhoneAccounts > 0;
  if (hasCreds && hasAccount) {
    console.log('WhatsApp: skipped (already connected)');
    return 'skipped';
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      wabaId: env.wabaId,
      waNumberId: env.phoneNumberId,
      waToken: env.whatsappAccessToken,
    },
  });

  await prisma.whatsAppPhoneAccount.upsert({
    where: {
      workspaceId_phoneNumberId: {
        workspaceId,
        phoneNumberId: env.phoneNumberId,
      },
    },
    create: {
      workspaceId,
      phoneNumberId: env.phoneNumberId,
      wabaId: env.wabaId,
    },
    update: {
      wabaId: env.wabaId,
    },
  });

  const action = mode === 'reconnect' ? 'reconnected' : 'connected';
  console.log(`WhatsApp: ${action}`);
  return action;
}

/** IG is connected when a status=connected InstagramAccount exists. */
async function ensureInstagramConnection(
  workspaceId: string,
  env: SuperAdminEnv,
  mode: 'connect' | 'reconnect'
): Promise<'skipped' | 'connected' | 'reconnected'> {
  const connected = await prisma.instagramAccount.findFirst({
    where: { workspaceId, status: 'connected' },
    select: { id: true },
  });
  if (connected) {
    console.log('Instagram: skipped (already connected)');
    return 'skipped';
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      fbPageId: env.facebookPageId,
      fbPageToken: env.instagramAccessToken,
    },
  });

  await prisma.instagramAccount.upsert({
    where: {
      workspaceId_instagramUserId: {
        workspaceId,
        instagramUserId: env.instagramAccountId,
      },
    },
    create: {
      workspaceId,
      instagramUserId: env.instagramAccountId,
      pageId: env.facebookPageId,
      pageAccessToken: env.instagramAccessToken,
      status: 'connected',
    },
    update: {
      pageId: env.facebookPageId,
      pageAccessToken: env.instagramAccessToken,
      status: 'connected',
    },
  });

  const action = mode === 'reconnect' ? 'reconnected' : 'connected';
  console.log(`Instagram: ${action}`);
  return action;
}

async function ensureSuperAdminWorkspace(env: SuperAdminEnv) {
  const existing = await prisma.workspace.findFirst({
    where: {
      OR: [{ slug: SUPER_ADMIN_SLUG }, { isSuperAdmin: true }],
    },
    select: { id: true, slug: true, name: true },
  });

  if (existing) {
    console.log(
      `Super admin tenant already exists (id=${existing.id}, slug=${existing.slug}, name=${existing.name}).`
    );
    await ensureWhatsAppConnection(existing.id, env, 'reconnect');
    await ensureInstagramConnection(existing.id, env, 'reconnect');
    return existing;
  }

  const unlimited = 2147483647;

  const workspace = await prisma.workspace.create({
    data: {
      name: SUPER_ADMIN_WORKSPACE_NAME,
      slug: SUPER_ADMIN_SLUG,
      isSuperAdmin: true,
      planTier: 'SUPER_ADMIN',
      subscriptionStatus: 'active',
      usageLimits: {
        create: {
          contactsLimit: unlimited,
          teamMembersLimit: unlimited,
          aiAgentsLimit: unlimited,
          channelsLimit: unlimited,
          aiTokensIncluded: 0,
          campaignsLimit: unlimited,
          emailsLimit: unlimited,
        },
      },
    },
    select: { id: true, slug: true, name: true },
  });

  console.log(`Super admin tenant created successfully. tenantId=${workspace.id}`);
  await ensureWhatsAppConnection(workspace.id, env, 'connect');
  await ensureInstagramConnection(workspace.id, env, 'connect');
  return workspace;
}

/** Platform console login (PlatformAdmin) — separate from workspace User. */
async function ensurePlatformAdmin(passwordHash: string) {
  const admin = await prisma.platformAdmin.upsert({
    where: { email: SUPER_ADMIN_EMAIL },
    create: {
      email: SUPER_ADMIN_EMAIL,
      name: SUPER_ADMIN_USER_NAME,
      password: passwordHash,
      role: 'super_admin',
    },
    update: {
      name: SUPER_ADMIN_USER_NAME,
      password: passwordHash,
      role: 'super_admin',
    },
  });
  console.log(`Platform admin ready: ${admin.email} (id=${admin.id})`);
  return admin;
}

async function ensureSuperAdminUser(workspaceId: string, passwordHash: string) {
  const existing = await prisma.user.findUnique({
    where: { email: SUPER_ADMIN_EMAIL },
    select: { id: true },
  });

  if (existing) {
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: SUPER_ADMIN_USER_NAME,
        password: passwordHash,
        role: SUPER_ADMIN_ROLE,
        workspaceId,
        onboardingCompleted: true,
        onboardingStep: 7,
      },
      select: { id: true },
    });

    await prisma.workspaceMembership.upsert({
      where: {
        userId_workspaceId: { userId: user.id, workspaceId },
      },
      create: {
        userId: user.id,
        workspaceId,
        role: SUPER_ADMIN_ROLE,
      },
      update: {
        role: SUPER_ADMIN_ROLE,
      },
    });

    console.log(`Super admin user updated and linked to workspace. userId=${user.id}`);
    return user;
  }

  const user = await prisma.user.create({
    data: {
      name: SUPER_ADMIN_USER_NAME,
      email: SUPER_ADMIN_EMAIL,
      password: passwordHash,
      role: SUPER_ADMIN_ROLE,
      workspaceId,
      onboardingCompleted: true,
      onboardingStep: 7,
      memberships: {
        create: {
          workspaceId,
          role: SUPER_ADMIN_ROLE,
        },
      },
    },
    select: { id: true },
  });

  console.log(`Super admin user created. userId=${user.id}`);
  return user;
}

async function main() {
  const env = loadSuperAdminEnv();
  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 12);

  const workspace = await ensureSuperAdminWorkspace(env);
  await ensureSuperAdminUser(workspace.id, passwordHash);
  await ensurePlatformAdmin(passwordHash);

  console.log('');
  console.log('Super admin login credentials:');
  console.log(`  Email: ${SUPER_ADMIN_EMAIL}`);
  console.log(`  Password: ${SUPER_ADMIN_PASSWORD}`);
  console.log('  (workspace User + platform PlatformAdmin)');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
