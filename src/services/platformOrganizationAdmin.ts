import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../index.js';
import { ccToDebitPaise } from './usageCost.constants.js';
import { creditWallet, getWalletSummary } from './wallet.service.js';
import { config } from '../config.js';
import {
  getWorkspaceOwnerUserId,
  resolveMembershipAccess,
} from './workspaceMemberAdmin.js';
import { onboardingPayloadFromUser } from './onboarding.js';
import { activateWorkspaceSubscription } from './trial.js';
import { signSessionToken } from './userSecurity.js';
import { updateUserProfile, validateAvatarValue } from './userProfile.js';
import {
  getSubscriptionPlanBySlug,
  syncWorkspaceLimitsFromPlanFeatures,
  type PlanFeatures,
} from './subscriptionPlans.js';

export type PlatformCompanyUpdate = {
  name?: string;
  legalName?: string | null;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postalCode?: string | null;
  timezone?: string | null;
  taxId?: string | null;
  logoUrl?: string | null;
  companySize?: string | null;
};

export async function suspendWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');
  if (workspace.subscriptionStatus === 'suspended') {
    throw new Error('Workspace is already suspended');
  }

  return prisma.workspace.update({
    where: { id: workspaceId },
    data: { subscriptionStatus: 'suspended' },
  });
}

export async function reactivateWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');
  if (workspace.subscriptionStatus !== 'suspended') {
    throw new Error('Workspace is not suspended');
  }
  return activateWorkspaceSubscription(workspaceId);
}

export async function updateWorkspaceLimits(
  workspaceId: string,
  limits: {
    contactsLimit?: number;
    teamMembersLimit?: number;
    aiAgentsLimit?: number;
    channelsLimit?: number;
    aiTokensIncluded?: number;
    campaignsLimit?: number;
    emailsLimit?: number;
  }
) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');

  const data = Object.fromEntries(
    Object.entries(limits).filter(([, value]) => value !== undefined)
  );
  if (Object.keys(data).length === 0) {
    throw new Error('At least one limit must be provided');
  }

  return prisma.workspaceUsageLimits.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  });
}

const LIVE_BILLING_SUB_STATUSES = ['active', 'authenticated', 'paused'] as const;

/**
 * Attach a catalog (or custom) plan to a workspace and sync usage limits.
 * Same entitlement sync as Razorpay verify/webhook — no BillingSubscription row.
 */
export async function assignPlanToWorkspace(workspaceId: string, planSlug: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');
  if (workspace.subscriptionStatus === 'suspended') {
    throw new Error('Reactivate the workspace before assigning a plan');
  }

  const plan = await getSubscriptionPlanBySlug(planSlug);
  if (!plan || !plan.isActive) throw new Error('Plan not found or inactive');

  // Mirror paid verify path workspace fields (minus BillingSubscription / wallet credit)
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      planId: plan.id,
      subscriptionStatus: 'active',
      trialEndsAt: null,
      // Clear builder quote so org shows as this plan, not Custom quote
      customPlanSelection: Prisma.DbNull,
    },
  });

  await syncWorkspaceLimitsFromPlanFeatures(workspaceId, plan.features as PlanFeatures);

  return {
    workspaceId,
    planSlug: plan.slug,
    planName: plan.name,
    subscriptionStatus: 'active' as const,
  };
}

/** Update workspace company profile fields (super-admin). */
export async function updateOrganizationCompany(
  workspaceId: string,
  input: PlatformCompanyUpdate
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, email: true, phone: true },
  });
  if (!workspace) throw new Error('Workspace not found');

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) data[key] = value === '' ? null : value;
  }
  if ('logoUrl' in data) {
    data.logoUrl = validateAvatarValue(data.logoUrl as string | null | undefined);
  }
  if ('name' in data && typeof data.name === 'string') {
    const name = data.name.trim();
    if (name.length < 2) throw new Error('Company name must be at least 2 characters');
    data.name = name;
  }
  if ('email' in data) {
    const next =
      data.email == null ? null : String(data.email).trim().toLowerCase() || null;
    data.email = next;
    const prev = workspace.email?.trim().toLowerCase() ?? null;
    if (next !== prev) data.emailVerifiedAt = null;
  }
  if ('phone' in data) {
    const next =
      data.phone == null ? null : String(data.phone).replace(/\D/g, '') || null;
    data.phone = next;
    const prev = workspace.phone?.replace(/\D/g, '') ?? null;
    if (next !== prev) data.phoneVerifiedAt = null;
  }

  if (Object.keys(data).length === 0) throw new Error('Nothing to update');

  return prisma.workspace.update({
    where: { id: workspaceId },
    data,
    select: {
      id: true,
      name: true,
      legalName: true,
      industry: true,
      website: true,
      email: true,
      phone: true,
      address: true,
      city: true,
      state: true,
      country: true,
      postalCode: true,
      timezone: true,
      taxId: true,
      logoUrl: true,
      companySize: true,
    },
  });
}

/** Update primary owner user profile (super-admin). */
export async function updateOrganizationOwner(
  workspaceId: string,
  input: { name?: string; phone?: string | null; email?: string }
) {
  const ownerUserId = await getWorkspaceOwnerUserId(workspaceId);
  if (!ownerUserId) throw new Error('No owner user found for this workspace');

  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Valid email is required');
    }
    const clash = await prisma.user.findFirst({
      where: { email, NOT: { id: ownerUserId } },
      select: { id: true },
    });
    if (clash) throw new Error('Email is already used by another account');

    await prisma.user.update({
      where: { id: ownerUserId },
      data: { email },
    });
  }

  if (input.name !== undefined || input.phone !== undefined) {
    await updateUserProfile(ownerUserId, {
      name: input.name,
      phone: input.phone,
    });
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: ownerUserId },
    select: { id: true, name: true, email: true, phone: true },
  });

  return { workspaceId, owner: user };
}

/**
 * Strip plan from a workspace: clear planId, cancel live billing rows.
 * Caller should cancel Razorpay subscriptions first when linked.
 * Trial/suspended status is preserved; paid → cancelled.
 */
export async function removePlanFromWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: { plan: { select: { slug: true, name: true } } },
  });
  if (!workspace) throw new Error('Workspace not found');

  const liveSubs = await prisma.billingSubscription.findMany({
    where: {
      workspaceId,
      status: { in: [...LIVE_BILLING_SUB_STATUSES] },
    },
    select: {
      id: true,
      razorpaySubscriptionId: true,
    },
  });

  const hasCustomQuote = workspace.customPlanSelection != null;
  if (!workspace.planId && liveSubs.length === 0 && !hasCustomQuote) {
    throw new Error('No plan or billing subscription to remove');
  }

  if (liveSubs.length > 0) {
    await prisma.billingSubscription.updateMany({
      where: { id: { in: liveSubs.map((s) => s.id) } },
      data: {
        status: 'cancelled',
        cancelAtPeriodEnd: false,
        cancelledAt: new Date(),
      },
    });
  }

  const keepStatus =
    workspace.subscriptionStatus === 'trial' || workspace.subscriptionStatus === 'suspended';
  const nextStatus = keepStatus ? workspace.subscriptionStatus : 'cancelled';

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      planId: null,
      customPlanSelection: Prisma.DbNull,
      subscriptionStatus: nextStatus,
    },
  });

  return {
    workspaceId,
    removedPlanSlug: workspace.plan?.slug ?? null,
    removedPlanName: workspace.plan?.name ?? null,
    cancelledBillingSubs: liveSubs.length,
    razorpaySubscriptionIds: liveSubs
      .map((s) => s.razorpaySubscriptionId)
      .filter((id): id is string => Boolean(id)),
    subscriptionStatus: nextStatus,
  };
}

export async function setWorkspaceAgentEnabled(
  workspaceId: string,
  agentId: string,
  isEnabled: boolean
) {
  const agent = await prisma.aiAgent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, name: true, isEnabled: true },
  });
  if (!agent) throw new Error('AI agent not found in this workspace');

  const updated = await prisma.aiAgent.update({
    where: { id: agentId },
    data: { isEnabled },
    select: { id: true, name: true, isEnabled: true, isPublished: true },
  });

  return updated;
}

export async function getWorkspaceAuditTrail(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, subscriptionStatus: true, createdAt: true, updatedAt: true },
  });
  if (!workspace) throw new Error('Workspace not found');

  const trialLogs = await prisma.trialExtensionLog.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { platformAdmin: { select: { name: true, email: true } } },
  });

  const events = trialLogs.map((log) => ({
    id: log.id,
    type: 'trial_extended' as const,
    title: `Trial extended by ${log.daysAdded} day${log.daysAdded === 1 ? '' : 's'}`,
    detail: log.reason,
    actor: log.platformAdmin?.name ?? 'Platform admin',
    actorEmail: log.platformAdmin?.email ?? null,
    at: log.createdAt.toISOString(),
  }));

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      subscriptionStatus: workspace.subscriptionStatus,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    },
    events,
  };
}

export async function createWorkspaceImpersonationSession(
  fastify: FastifyInstance,
  workspaceId: string,
  platformAdminId: string
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true },
  });
  if (!workspace) throw new Error('Workspace not found');

  const ownerUserId = await getWorkspaceOwnerUserId(workspaceId);
  if (!ownerUserId) throw new Error('No workspace owner found');

  const user = await prisma.user.findUnique({ where: { id: ownerUserId } });
  if (!user) throw new Error('Owner user not found');

  const access = await resolveMembershipAccess(user.id, workspaceId);
  const token = await signSessionToken(fastify, {
    userId: user.id,
    workspaceId,
    expiresIn: '2h',
    impersonatedBy: platformAdminId,
  });

  return {
    token,
    appUrl: config.frontendUrl,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      role: access.role,
      permissions: access.permissions,
      inboxScope: access.inboxScope,
      ...onboardingPayloadFromUser(user),
    },
    workspace: { id: workspace.id, name: workspace.name },
    activeWorkspaceId: workspaceId,
  };
}

export async function creditOrganizationWallet(
  workspaceId: string,
  params: {
    amountCc: number;
    note?: string | null;
    platformAdminId: string;
    idempotencyKey?: string | null;
  }
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true },
  });
  if (!workspace) throw new Error('Workspace not found');

  const amountCc = Math.round(params.amountCc);
  if (amountCc <= 0) throw new Error('Credit amount must be at least 1 CC');

  const amountPaise = ccToDebitPaise(amountCc);
  const note = params.note?.trim() || null;
  const walletIdempotencyKey = params.idempotencyKey?.trim()
    ? `platform-manual:${params.idempotencyKey.trim()}`
    : undefined;

  if (walletIdempotencyKey) {
    const existingTx = await prisma.walletTransaction.findUnique({
      where: { idempotencyKey: walletIdempotencyKey },
      select: { referenceId: true },
    });
    if (existingTx?.referenceId) {
      const invoice = await prisma.billingInvoice.findUnique({
        where: { id: existingTx.referenceId },
      });
      if (invoice) {
        const wallet = await getWalletSummary(workspaceId);
        return {
          ok: true as const,
          alreadyApplied: true,
          workspaceId,
          invoiceId: invoice.id,
          amountCc,
          amountPaise,
          wallet,
        };
      }
    }
  }

  const description = note
    ? `Wallet top-up (manual) — ${note}`
    : 'Wallet top-up (manual)';

  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.billingInvoice.create({
      data: {
        workspaceId,
        type: 'wallet_topup_manual',
        amountPaise,
        currency: 'INR',
        status: 'paid',
        description,
        paidAt: new Date(),
        metadata: {
          purpose: 'wallet_topup_manual',
          creditAmountPaise: amountPaise,
          amountCc,
          note,
          platformAdminId: params.platformAdminId,
          source: 'platform_admin',
          ...(params.idempotencyKey?.trim()
            ? { idempotencyKey: params.idempotencyKey.trim() }
            : {}),
        } as Prisma.InputJsonValue,
      },
    });

    const { wallet } = await creditWallet({
      workspaceId,
      amountPaise,
      category: 'wallet_topup',
      description: note ? `Manual credit — ${note}` : 'Manual ConvoCoins credit',
      referenceType: 'invoice',
      referenceId: invoice.id,
      idempotencyKey: walletIdempotencyKey ?? `manual-topup:${invoice.id}`,
      metadata: {
        platformAdminId: params.platformAdminId,
        amountCc,
      },
      tx,
    });

    return { invoice, wallet };
  });

  const wallet = await getWalletSummary(workspaceId);

  return {
    ok: true as const,
    alreadyApplied: false,
    workspaceId,
    invoiceId: result.invoice.id,
    amountCc,
    amountPaise,
    wallet: {
      balancePaise: wallet.balancePaise,
      balanceInr: wallet.balanceInr,
    },
  };
}
