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
    labelColor: '#6B7280',
    priceMonthly: 29,
    priceAnnual: 290,
    priceMonthlyPaise: 99900,
    priceAnnualPaise: 999900,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    editButtonStyle: 'gray',
    sortOrder: 1,
    trialDays: 14,
    features: {
      contacts: '1,000',
      teamMembers: '2',
      aiAgents: '1',
      channels: '2',
      messagesPerMonth: 10000,
      storageGb: 5,
      apiAccess: false,
      customBranding: false,
      prioritySupport: false,
      aiReplies: 500,
      campaigns: 3,
      integrations: 2,
      emailsPerMonth: 1000,
    },
  },
  {
    slug: 'growth',
    planCode: 'tier_grw',
    name: 'GROWTH',
    labelColor: '#6C63FF',
    priceMonthly: 79,
    priceAnnual: 790,
    priceMonthlyPaise: 249900,
    priceAnnualPaise: 2499900,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    popular: true,
    borderColor: '#6C63FF',
    editButtonStyle: 'purple',
    sortOrder: 2,
    trialDays: 14,
    features: {
      contacts: '5,000',
      teamMembers: '10',
      aiAgents: '5',
      channels: '5',
      messagesPerMonth: 50000,
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
  {
    slug: 'pro',
    planCode: 'tier_pro',
    name: 'PRO',
    labelColor: '#2563EB',
    priceMonthly: 199,
    priceAnnual: 1990,
    priceMonthlyPaise: 599900,
    priceAnnualPaise: 5999900,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    editButtonStyle: 'blue',
    sortOrder: 3,
    trialDays: 14,
    features: {
      contacts: '25,000',
      teamMembers: '50',
      aiAgents: '20',
      channels: 'Unlimited',
      messagesPerMonth: 250000,
      storageGb: 100,
      apiAccess: true,
      customBranding: true,
      prioritySupport: true,
      channelsUnlimited: true,
      aiReplies: 'unlimited',
      campaigns: 'unlimited',
      integrations: 25,
      emailsPerMonth: 25000,
    },
  },
  {
    slug: 'enterprise',
    planCode: 'tier_ent',
    name: 'ENTERPRISE',
    labelColor: '#111827',
    priceMonthly: null,
    priceAnnual: 0,
    priceMonthlyPaise: null,
    priceAnnualPaise: null,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    priceLabel: 'Custom',
    editButtonStyle: 'dark',
    sortOrder: 4,
    trialDays: 14,
    features: {
      contacts: 'Custom',
      teamMembers: 'Custom',
      aiAgents: 'Custom',
      channels: 'Custom',
      messagesPerMonth: 0,
      storageGb: 0,
      apiAccess: true,
      customBranding: true,
      prioritySupport: true,
      channelsUnlimited: true,
      aiReplies: 'custom',
      campaigns: 'custom',
      integrations: 'custom',
      emailsPerMonth: 'custom',
    },
  },
];

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

export async function listSubscriptionPlans() {
  return prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
}

export async function getSubscriptionPlanBySlug(slug: string) {
  return prisma.subscriptionPlan.findUnique({ where: { slug } });
}

export function planDisplayName(slug: string) {
  if (!slug) return 'Starter';
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
    const emailsLimit = parseEmailsPerMonthLimit(features.emailsPerMonth, 1000);

    await prisma.workspaceUsageLimits.upsert({
      where: { workspaceId: workspace.id },
      create: {
        workspaceId: workspace.id,
        contactsLimit: parseFeatureLimitForBackfill(features.contacts, 1000),
        teamMembersLimit: parseFeatureLimitForBackfill(features.teamMembers, 2),
        aiAgentsLimit: parseFeatureLimitForBackfill(features.aiAgents, 1),
        channelsLimit: parseFeatureLimitForBackfill(features.channels, 2),
        aiTokensIncluded: typeof features.aiReplies === 'number' ? features.aiReplies : 0,
        campaignsLimit:
          typeof features.campaigns === 'number'
            ? features.campaigns
            : features.campaigns === 'unlimited'
              ? Number.MAX_SAFE_INTEGER
              : 3,
        emailsLimit,
      },
      update: { emailsLimit },
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
