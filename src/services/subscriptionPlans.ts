import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type PlanFeatures = {
  contacts: string;
  teamMembers: string;
  aiAgents: string;
  channels: string;
  messagesPerMonth?: number;
  storageGb?: number;
  apiAccess?: boolean;
  customBranding?: boolean;
  prioritySupport?: boolean;
  channelsUnlimited?: boolean;
  aiReplies?: number | 'unlimited' | 'custom';
  campaigns?: number | 'unlimited' | 'custom';
  integrations?: number | 'unlimited' | 'custom';
  emailsPerMonth?: number | 'unlimited' | 'custom';
};

export const DEFAULT_PLAN_SEEDS: Array<{
  slug: string;
  planCode: string;
  name: string;
  labelColor: string;
  priceMonthly: number | null;
  priceAnnual: number | null;
  priceMonthlyPaise: number | null;
  priceAnnualPaise: number | null;
  razorpayPlanIdMonthly: string | null;
  razorpayPlanIdAnnual: string | null;
  priceLabel?: string;
  popular?: boolean;
  borderColor?: string;
  editButtonStyle: string;
  sortOrder: number;
  trialDays: number;
  features: PlanFeatures;
}> = [
  {
    slug: 'starter',
    planCode: 'tier_strt',
    name: 'STARTER',
    labelColor: '#064e3b',
    // INR rupees (landing: ₹1,999/mo)
    priceMonthly: 1999,
    priceAnnual: 19990,
    priceMonthlyPaise: 199_900,
    priceAnnualPaise: 1_999_000,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    popular: true,
    borderColor: '#064e3b',
    editButtonStyle: 'purple',
    sortOrder: 1,
    trialDays: 14,
    features: {
      contacts: '2,000',
      teamMembers: '3',
      aiAgents: '1',
      channels: '4',
      messagesPerMonth: 50_000,
      storageGb: 25,
      apiAccess: true,
      customBranding: false,
      prioritySupport: false,
      aiReplies: 2500,
      campaigns: 15,
      integrations: 8,
      emailsPerMonth: 5000,
    },
  },
];

/** Old multi-tier catalog — seed deactivates these; custom-* plans are left alone. */
const RETIRED_PUBLIC_SLUGS = ['growth', 'pro', 'enterprise'] as const;

export async function seedSubscriptionPlans() {
  const plans = [];

  for (const seed of DEFAULT_PLAN_SEEDS) {
    const plan = await prisma.subscriptionPlan.upsert({
      where: { slug: seed.slug },
      create: {
        slug: seed.slug,
        planCode: seed.planCode,
        name: seed.name,
        labelColor: seed.labelColor,
        priceMonthly: seed.priceMonthly,
        priceAnnual: seed.priceAnnual,
        priceMonthlyPaise: seed.priceMonthlyPaise,
        priceAnnualPaise: seed.priceAnnualPaise,
        razorpayPlanIdMonthly: seed.razorpayPlanIdMonthly,
        razorpayPlanIdAnnual: seed.razorpayPlanIdAnnual,
        priceLabel: seed.priceLabel,
        popular: seed.popular ?? false,
        borderColor: seed.borderColor,
        editButtonStyle: seed.editButtonStyle,
        sortOrder: seed.sortOrder,
        trialDays: seed.trialDays,
        features: seed.features as Prisma.InputJsonValue,
      },
      update: {
        planCode: seed.planCode,
        name: seed.name,
        labelColor: seed.labelColor,
        priceMonthly: seed.priceMonthly,
        priceAnnual: seed.priceAnnual,
        priceMonthlyPaise: seed.priceMonthlyPaise,
        priceAnnualPaise: seed.priceAnnualPaise,
        priceLabel: seed.priceLabel,
        popular: seed.popular ?? false,
        borderColor: seed.borderColor,
        editButtonStyle: seed.editButtonStyle,
        sortOrder: seed.sortOrder,
        trialDays: seed.trialDays,
        features: seed.features as Prisma.InputJsonValue,
        isActive: true,
      },
    });
    plans.push(plan);
  }

  // Retire old public tiers only — leave custom-* plans alone
  await prisma.subscriptionPlan.updateMany({
    where: { slug: { in: [...RETIRED_PUBLIC_SLUGS] } },
    data: { isActive: false },
  });

  return plans;
}

/** Trial workspaces are not tied to a plan until purchase. */
export async function detachPlansFromTrialWorkspaces() {
  const result = await prisma.workspace.updateMany({
    where: { subscriptionStatus: 'trial' },
    data: { planId: null },
  });
  return result.count;
}

/** Admin-created plans use `custom-` slug prefix; never shown on public checkout. */
export function isCustomPlanSlug(slug: string) {
  return slug.startsWith('custom-');
}

export async function listSubscriptionPlans(opts?: { includeCustom?: boolean }) {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (opts?.includeCustom) return plans;
  return plans.filter((p) => !isCustomPlanSlug(p.slug));
}

export async function getSubscriptionPlanBySlug(slug: string) {
  return prisma.subscriptionPlan.findUnique({ where: { slug } });
}

export type PlanWriteInput = {
  name: string;
  planCode?: string;
  priceMonthly: number | null;
  priceAnnual: number | null;
  features: PlanFeatures;
  popular?: boolean;
  labelColor?: string;
  borderColor?: string;
  editButtonStyle?: string;
};

function slugifyPlanName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'plan';
}

function toPaise(rupees: number | null) {
  if (rupees == null || !Number.isFinite(rupees)) return null;
  return Math.round(rupees * 100);
}

async function uniqueCustomSlug(baseName: string) {
  const base = `custom-${slugifyPlanName(baseName)}`;
  let slug = base;
  let n = 2;
  while (await prisma.subscriptionPlan.findUnique({ where: { slug } })) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

async function uniquePlanCode(preferred?: string) {
  const base =
    preferred?.trim().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) ||
    `tier_cstm_${Date.now().toString(36).slice(-6)}`;
  let code = base;
  let n = 2;
  while (await prisma.subscriptionPlan.findUnique({ where: { planCode: code } })) {
    code = `${base.slice(0, 20)}_${n}`;
    n += 1;
  }
  return code;
}

export async function createCustomSubscriptionPlan(input: PlanWriteInput) {
  const slug = await uniqueCustomSlug(input.name);
  const planCode = await uniquePlanCode(input.planCode);
  const customCount = await prisma.subscriptionPlan.count({
    where: { slug: { startsWith: 'custom-' } },
  });

  return prisma.subscriptionPlan.create({
    data: {
      slug,
      planCode,
      name: input.name.trim().toUpperCase(),
      labelColor: input.labelColor ?? '#7C3AED',
      priceMonthly: input.priceMonthly,
      priceAnnual: input.priceAnnual,
      priceMonthlyPaise: toPaise(input.priceMonthly),
      priceAnnualPaise: toPaise(input.priceAnnual),
      popular: input.popular ?? false,
      borderColor: input.borderColor ?? '#7C3AED',
      editButtonStyle: input.editButtonStyle ?? 'purple',
      sortOrder: 100 + customCount,
      trialDays: 0,
      features: input.features as Prisma.InputJsonValue,
      isActive: true,
    },
  });
}

export async function updateSubscriptionPlan(slug: string, input: PlanWriteInput) {
  const existing = await prisma.subscriptionPlan.findUnique({ where: { slug } });
  if (!existing) throw new Error('Plan not found');
  if (!existing.isActive) throw new Error('Plan is inactive');

  const data: Prisma.SubscriptionPlanUpdateInput = {
    name: input.name.trim().toUpperCase(),
    priceMonthly: input.priceMonthly,
    priceAnnual: input.priceAnnual,
    priceMonthlyPaise: toPaise(input.priceMonthly),
    priceAnnualPaise: toPaise(input.priceAnnual),
    labelColor: input.labelColor ?? existing.labelColor,
    borderColor: input.borderColor ?? existing.borderColor,
    editButtonStyle: input.editButtonStyle ?? existing.editButtonStyle,
    popular: input.popular ?? existing.popular,
    features: input.features as Prisma.InputJsonValue,
  };

  // Don't churn planCode on edit — uniqueness fights the same code
  return prisma.subscriptionPlan.update({ where: { slug }, data });
}

export async function syncWorkspaceLimitsFromPlanFeatures(
  workspaceId: string,
  features: PlanFeatures
) {
  const campaignsLimit =
    typeof features.campaigns === 'number'
      ? features.campaigns
      : features.campaigns === 'unlimited'
        ? Number.MAX_SAFE_INTEGER
        : 3;

  return prisma.workspaceUsageLimits.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      contactsLimit: parseFeatureLimitForBackfill(features.contacts, 1000),
      teamMembersLimit: parseFeatureLimitForBackfill(features.teamMembers, 3),
      aiAgentsLimit: parseFeatureLimitForBackfill(features.aiAgents, 1),
      channelsLimit: parseFeatureLimitForBackfill(features.channels, 2),
      aiTokensIncluded: 0,
      campaignsLimit,
      // ponytail: wallet bills email — don't gift plan emails as free quota
      emailsLimit: 0,
    },
    update: {
      contactsLimit: parseFeatureLimitForBackfill(features.contacts, 1000),
      teamMembersLimit: parseFeatureLimitForBackfill(features.teamMembers, 3),
      aiAgentsLimit: parseFeatureLimitForBackfill(features.aiAgents, 1),
      channelsLimit: parseFeatureLimitForBackfill(features.channels, 2),
      aiTokensIncluded: 0,
      campaignsLimit,
      emailsLimit: 0,
    },
  });
}

export function planDisplayName(slug: string) {
  if (!slug) return 'Starter';
  if (isCustomPlanSlug(slug)) {
    return slug.replace(/^custom-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function serializeSubscriptionPlan(plan: Awaited<ReturnType<typeof listSubscriptionPlans>>[number]) {
  const features = plan.features as PlanFeatures;
  return {
    id: plan.slug,
    dbId: plan.id,
    planId: plan.planCode,
    name: plan.name,
    labelColor: plan.labelColor,
    price: plan.priceMonthly,
    priceLabel: plan.priceLabel ?? undefined,
    features: {
      contacts: features.contacts,
      teamMembers: features.teamMembers,
      aiAgents: features.aiAgents,
      channels: features.channels,
    },
    popular: plan.popular,
    borderColor: plan.borderColor ?? undefined,
    editButtonStyle: plan.editButtonStyle as 'gray' | 'purple' | 'blue' | 'dark',
    annualPrice: plan.priceAnnual ?? undefined,
    priceMonthlyPaise: plan.priceMonthlyPaise ?? undefined,
    priceAnnualPaise: plan.priceAnnualPaise ?? undefined,
    messagesPerMonth: features.messagesPerMonth,
    storageGb: features.storageGb,
    apiAccess: features.apiAccess,
    customBranding: features.customBranding,
    prioritySupport: features.prioritySupport,
    channelsUnlimited: features.channelsUnlimited,
    aiReplies: features.aiReplies,
    campaigns: features.campaigns,
    integrations: features.integrations,
    emailsPerMonth: features.emailsPerMonth,
    sortOrder: plan.sortOrder,
    trialDays: plan.trialDays,
    isActive: plan.isActive,
    isCustom: isCustomPlanSlug(plan.slug),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

export function serializeTenantSubscriptionPlan(
  plan: Awaited<ReturnType<typeof listSubscriptionPlans>>[number]
) {
  const { dbId: _dbId, ...rest } = serializeSubscriptionPlan(plan);
  return rest;
}

function parseEmailsPerMonthLimit(value: PlanFeatures['emailsPerMonth'], fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  if (value === 'unlimited' || value === 'custom') return Number.MAX_SAFE_INTEGER;
  return fallback;
}

/** Sync plan-derived usage limits (including emails) for workspaces on paid plans. */
export async function backfillWorkspaceUsageLimitsFromPlans() {
  const workspaces = await prisma.workspace.findMany({
    where: { planId: { not: null } },
    include: { plan: true, usageLimits: true },
  });

  let updated = 0;
  for (const workspace of workspaces) {
    if (!workspace.plan) continue;
    const features = workspace.plan.features as PlanFeatures;

    await prisma.workspaceUsageLimits.upsert({
      where: { workspaceId: workspace.id },
      create: {
        workspaceId: workspace.id,
        contactsLimit: parseFeatureLimitForBackfill(features.contacts, 1000),
        teamMembersLimit: parseFeatureLimitForBackfill(features.teamMembers, 3),
        aiAgentsLimit: parseFeatureLimitForBackfill(features.aiAgents, 1),
        channelsLimit: parseFeatureLimitForBackfill(features.channels, 2),
        aiTokensIncluded: 0,
        campaignsLimit:
          typeof features.campaigns === 'number'
            ? features.campaigns
            : features.campaigns === 'unlimited'
              ? Number.MAX_SAFE_INTEGER
              : 3,
        emailsLimit: 0,
      },
      update: {
        aiTokensIncluded: 0,
        emailsLimit: 0,
      },
    });
    updated += 1;
  }

  return updated;
}

function parseFeatureLimitForBackfill(value: string | number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  const normalized = value.replace(/,/g, '').trim().toLowerCase();
  if (normalized === 'unlimited' || normalized === 'custom') return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
