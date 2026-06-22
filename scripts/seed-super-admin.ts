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
      wabaId: env.wabaId,
      waNumberId: env.phoneNumberId,
      waToken: env.whatsappAccessToken,
      fbPageId: env.facebookPageId,
      fbPageToken: env.instagramAccessToken,
      whatsappPhoneAccounts: {
        create: {
          phoneNumberId: env.phoneNumberId,
          wabaId: env.wabaId,
        },
      },
      instagramAccounts: {
        create: {
          instagramUserId: env.instagramAccountId,
          pageId: env.facebookPageId,
          pageAccessToken: env.instagramAccessToken,
        },
      },
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
  return workspace;
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

  console.log('');
  console.log('Super admin login credentials:');
  console.log(`  Email: ${SUPER_ADMIN_EMAIL}`);
  console.log(`  Password: ${SUPER_ADMIN_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
