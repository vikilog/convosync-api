import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { UNLIMITED_USAGE_LIMIT } from './usageLimits.js';

export type PlanFeatures = {
  /** Always "Unlimited" — not a plan differentiator. */
  contacts: string;
  /** Team seats (landing: Team seats). */
  teamMembers: string;
  aiAgents: string;
  /** Channel label, e.g. "WhatsApp only" / "WhatsApp + Instagram". */
  channels: string;
  emailsPerMonth?: number | 'unlimited' | 'custom';
  /** e.g. "200 CC" */
  walletCredits?: string;
  aiCopilot?: boolean;
  socialListening?: boolean;
  voiceAgent?: boolean;
  developers?: boolean;
  whatsappPay?: boolean;
  ctwaAds?: boolean;
  /** e.g. "Basic" | "Advanced" | "Advanced + export" */
  reports?: string;
  /** Media gallery storage quota (GB). Omit on Enterprise → custom. */
  storageGb?: number;
  // Legacy optional fields (older plans / metering) — kept for back-compat.
  messagesPerMonth?: number;
  apiAccess?: boolean;
  customBranding?: boolean;
  prioritySupport?: boolean;
  channelsUnlimited?: boolean;
  aiReplies?: number | 'unlimited' | 'custom';
  campaigns?: number | 'unlimited' | 'custom';
  integrations?: number | 'unlimited' | 'custom';
};

/** Catalog plans include campaigns; only explicit numeric/custom caps apply. */
export function campaignsLimitFromFeatures(features: PlanFeatures): number {
  if (typeof features.campaigns === 'number') return features.campaigns;
  if (features.campaigns === 'unlimited' || features.campaigns === 'custom') {
    return UNLIMITED_USAGE_LIMIT;
  }
  return UNLIMITED_USAGE_LIMIT;
}

/** Landing `PRICING_PLANS` + compare-features table (annual ≈ 10× monthly). */
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
    name: 'Starter',
    labelColor: '#064e3b',
    priceMonthly: 1999,
    priceAnnual: 19990,
    priceMonthlyPaise: 199_900,
    priceAnnualPaise: 1_999_000,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    borderColor: '#064e3b',
    editButtonStyle: 'purple',
    sortOrder: 1,
    trialDays: 14,
    features: {
      contacts: 'Unlimited',
      teamMembers: '3',
      aiAgents: '1',
      channels: 'WhatsApp only',
      emailsPerMonth: 500,
      walletCredits: '200 CC',
      aiCopilot: false,
      socialListening: false,
      voiceAgent: false,
      developers: false,
      whatsappPay: false,
      ctwaAds: false,
      reports: 'Basic',
      storageGb: 0,
      campaigns: 'unlimited',
    },
  },
  {
    slug: 'growth',
    planCode: 'tier_grwth',
    name: 'Growth',
    labelColor: '#0f766e',
    priceMonthly: 4999,
    priceAnnual: 49990,
    priceMonthlyPaise: 499_900,
    priceAnnualPaise: 4_999_000,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    borderColor: '#0f766e',
    editButtonStyle: 'blue',
    sortOrder: 2,
    trialDays: 14,
    features: {
      contacts: 'Unlimited',
      teamMembers: '8',
      aiAgents: '3',
      channels: 'WhatsApp + Instagram',
      emailsPerMonth: 2500,
      walletCredits: '750 CC',
      aiCopilot: true,
      socialListening: false,
      voiceAgent: false,
      developers: false,
      whatsappPay: false,
      ctwaAds: false,
      reports: 'Basic',
      storageGb: 1,
      campaigns: 'unlimited',
    },
  },
  {
    slug: 'business',
    planCode: 'tier_biz',
    name: 'Business',
    labelColor: '#064e3b',
    priceMonthly: 12999,
    priceAnnual: 129990,
    priceMonthlyPaise: 1_299_900,
    priceAnnualPaise: 12_999_000,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    popular: true,
    borderColor: '#064e3b',
    editButtonStyle: 'dark',
    sortOrder: 3,
    trialDays: 14,
    features: {
      contacts: 'Unlimited',
      teamMembers: '25',
      aiAgents: '10',
      channels: 'WhatsApp + Instagram + Messenger',
      emailsPerMonth: 10_000,
      walletCredits: '2,500 CC',
      aiCopilot: true,
      socialListening: true,
      voiceAgent: true,
      developers: true,
      whatsappPay: true,
      ctwaAds: false,
      reports: 'Advanced',
      storageGb: 5,
      campaigns: 'unlimited',
    },
  },
  {
    slug: 'enterprise',
    planCode: 'tier_ent',
    name: 'Enterprise',
    labelColor: '#1e293b',
    priceMonthly: null,
    priceAnnual: null,
    priceMonthlyPaise: null,
    priceAnnualPaise: null,
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
    priceLabel: 'Custom',
    borderColor: '#1e293b',
    editButtonStyle: 'gray',
    sortOrder: 4,
    trialDays: 14,
    features: {
      contacts: 'Unlimited',
      teamMembers: 'Unlimited',
      aiAgents: 'Unlimited',
      channels: 'All + priority setup',
      emailsPerMonth: 'custom',
      walletCredits: 'Custom',
      aiCopilot: true,
      socialListening: true,
      voiceAgent: true,
      developers: true,
      whatsappPay: true,
      ctwaAds: true,
      reports: 'Advanced + export',
    },
  },
];

/** Contacts are never a plan differentiator — always unlimited. */
export function normalizePlanFeatures(features: PlanFeatures): PlanFeatures {
  return { ...features, contacts: 'Unlimited' };
}

/** Parse plan.features.walletCredits (e.g. "200 CC", "2,500 CC") → monthly CC count. */
export function parsePlanWalletCreditsCc(walletCredits: string | undefined): number | null {
  if (!walletCredits) return null;
  const normalized = walletCredits.replace(/,/g, '').trim().toLowerCase();
  if (!normalized || normalized === 'custom' || normalized === '—' || normalized === '-') {
    return null;
  }
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*cc$/);
  if (match) return Number.parseFloat(match[1]!);
  const numMatch = normalized.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) return Number.parseFloat(numMatch[1]!);
  return null;
}

/** Map channel label → numeric limit for WorkspaceUsageLimits. */
export function channelsLimitFromLabel(
  channels: string,
  channelsUnlimited?: boolean
): number {
  if (channelsUnlimited) return UNLIMITED_USAGE_LIMIT;
  const trimmed = channels.replace(/,/g, '').trim();
  const asNum = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asNum)) return asNum;
  const c = channels.toLowerCase();
  if (c.includes('unlimited') || /\ball\b/.test(c)) return UNLIMITED_USAGE_LIMIT;
  if (c.includes('messenger')) return 3;
  if (c.includes('instagram')) return 2;
  if (c.includes('whatsapp')) return 1;
  return 2;
}

export type PlanChannelKind = 'whatsapp' | 'instagram' | 'messenger' | 'email';

export function channelTypeAllowedByPlan(
  features: PlanFeatures,
  channel: PlanChannelKind
): boolean {
  const label = features.channels.toLowerCase();
  if (features.channelsUnlimited || label.includes('unlimited') || /\ball\b/.test(label)) {
    return true;
  }
  if (channel === 'email') {
    // ponytail: email always allowed by channel type; send volume is gated separately
    return true;
  }
  if (channel === 'whatsapp') return label.includes('whatsapp');
  if (channel === 'instagram') return label.includes('instagram');
  if (channel === 'messenger') return label.includes('messenger');
  return false;
}

export function planFeatureEnabled(
  features: PlanFeatures,
  flag: keyof Pick<
    PlanFeatures,
    'aiCopilot' | 'socialListening' | 'voiceAgent' | 'developers' | 'whatsappPay' | 'ctwaAds'
  >
): boolean {
  return Boolean(features[flag]);
}

const GB_BYTES = 1024 * 1024 * 1024;

/** Omitted storageGb = custom/unlimited (Enterprise). Explicit 0 = no gallery. */
export function mediaGalleryAllowedByPlan(features: PlanFeatures): boolean {
  if (features.storageGb === undefined) return true;
  return features.storageGb > 0;
}

/** null = custom/unlimited quota; number = byte cap from plan.features.storageGb. */
export function storageLimitBytesFromPlan(features: PlanFeatures): number | null {
  if (features.storageGb === undefined) return null;
  return features.storageGb * GB_BYTES;
}

/** Legacy public slug — seed deactivates; custom-* plans are left alone. */
const RETIRED_PUBLIC_SLUGS = ['pro'] as const;

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

export async function listSubscriptionPlans(opts?: {
  includeCustom?: boolean;
  /** Super-admin list — include deactivated plans. */
  includeInactive?: boolean;
}) {
  const plans = await prisma.subscriptionPlan.findMany({
    where: opts?.includeInactive ? undefined : { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (opts?.includeCustom) return plans;
  return plans.filter((p) => !isCustomPlanSlug(p.slug));
}

export async function setSubscriptionPlanActive(slug: string, isActive: boolean) {
  const existing = await prisma.subscriptionPlan.findUnique({ where: { slug } });
  if (!existing) throw new Error('Plan not found');
  return prisma.subscriptionPlan.update({
    where: { slug },
    data: { isActive },
  });
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
  razorpayPlanIdMonthly?: string | null;
  razorpayPlanIdAnnual?: string | null;
};

export type PlanCreateKind = 'public' | 'custom';

export function slugifyPlanName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'plan';
}

/** Slug base before uniqueness suffix — custom always uses `custom-` prefix. */
export function planSlugBase(name: string, kind: PlanCreateKind) {
  const base = slugifyPlanName(name);
  return kind === 'custom' ? `custom-${base}` : base;
}

function toPaise(rupees: number | null) {
  if (rupees == null || !Number.isFinite(rupees)) return null;
  return Math.round(rupees * 100);
}

async function uniquePlanSlug(baseName: string, kind: PlanCreateKind) {
  const base = planSlugBase(baseName, kind);
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

async function nextSortOrder(kind: PlanCreateKind) {
  if (kind === 'custom') {
    const customCount = await prisma.subscriptionPlan.count({
      where: { slug: { startsWith: 'custom-' } },
    });
    return 100 + customCount;
  }
  const maxPublic = await prisma.subscriptionPlan.aggregate({
    where: { slug: { not: { startsWith: 'custom-' } } },
    _max: { sortOrder: true },
  });
  return (maxPublic._max.sortOrder ?? 0) + 1;
}

export async function createSubscriptionPlan(
  input: PlanWriteInput,
  opts: { kind?: PlanCreateKind } = {}
) {
  const kind = opts.kind ?? 'custom';
  const slug = await uniquePlanSlug(input.name, kind);
  const planCode = await uniquePlanCode(input.planCode);
  const features = normalizePlanFeatures(input.features);
  const isCustom = kind === 'custom';
  const priceMonthly = input.priceMonthly;
  const priceAnnual = input.priceAnnual;
  const isCustomPriced = priceMonthly == null || priceMonthly <= 0;

  return prisma.subscriptionPlan.create({
    data: {
      slug,
      planCode,
      name: input.name.trim().toUpperCase(),
      labelColor: input.labelColor ?? (isCustom ? '#7C3AED' : '#064e3b'),
      priceMonthly: isCustomPriced ? null : priceMonthly,
      priceAnnual: priceAnnual != null && priceAnnual > 0 ? priceAnnual : null,
      priceMonthlyPaise: isCustomPriced ? null : toPaise(priceMonthly),
      priceAnnualPaise:
        priceAnnual != null && priceAnnual > 0 ? toPaise(priceAnnual) : null,
      priceLabel: isCustomPriced ? 'Custom' : null,
      popular: input.popular ?? false,
      borderColor: input.borderColor ?? (isCustom ? '#7C3AED' : '#064e3b'),
      editButtonStyle: input.editButtonStyle ?? (isCustom ? 'purple' : 'gray'),
      sortOrder: await nextSortOrder(kind),
      trialDays: isCustom ? 0 : 14,
      features: features as Prisma.InputJsonValue,
      isActive: true,
    },
  });
}

type RazorpayPlanCreator = (params: {
  name: string;
  amountPaise: number;
  period: 'monthly' | 'yearly';
  description?: string;
  notes?: Record<string, string>;
}) => Promise<{ id: string }>;

/**
 * Create Razorpay Subscription plans for monthly/annual prices and persist IDs.
 * No-op when amount is missing or creator is unavailable.
 */
export async function provisionRazorpayPlanIds(
  plan: {
    id: string;
    name: string;
    slug: string;
    priceMonthly: number | null;
    priceAnnual: number | null;
    priceMonthlyPaise: number | null;
    priceAnnualPaise: number | null;
  },
  createPlan: RazorpayPlanCreator | null
): Promise<{
  razorpayPlanIdMonthly: string | null;
  razorpayPlanIdAnnual: string | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let razorpayPlanIdMonthly: string | null = null;
  let razorpayPlanIdAnnual: string | null = null;

  if (!createPlan) {
    warnings.push('Razorpay is not configured — plan saved without Razorpay IDs');
    return { razorpayPlanIdMonthly, razorpayPlanIdAnnual, warnings };
  }

  const monthlyPaise =
    plan.priceMonthlyPaise ??
    (plan.priceMonthly != null && plan.priceMonthly > 0
      ? Math.round(plan.priceMonthly * 100)
      : null);
  const annualPaise =
    plan.priceAnnualPaise ??
    (plan.priceAnnual != null && plan.priceAnnual > 0
      ? Math.round(plan.priceAnnual * 100)
      : null);

  if (monthlyPaise && monthlyPaise > 0) {
    try {
      const created = await createPlan({
        name: `${plan.name} Monthly`,
        amountPaise: monthlyPaise,
        period: 'monthly',
        description: `ConvoSync ${plan.name} (monthly)`,
        notes: { convosync_slug: plan.slug, cycle: 'monthly' },
      });
      razorpayPlanIdMonthly = created.id;
    } catch (err) {
      warnings.push(
        `Monthly Razorpay plan failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  }

  if (annualPaise && annualPaise > 0) {
    try {
      const created = await createPlan({
        name: `${plan.name} Annual`,
        amountPaise: annualPaise,
        period: 'yearly',
        description: `ConvoSync ${plan.name} (annual)`,
        notes: { convosync_slug: plan.slug, cycle: 'annual' },
      });
      razorpayPlanIdAnnual = created.id;
    } catch (err) {
      warnings.push(
        `Annual Razorpay plan failed: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  }

  if (razorpayPlanIdMonthly || razorpayPlanIdAnnual) {
    await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: {
        ...(razorpayPlanIdMonthly ? { razorpayPlanIdMonthly } : {}),
        ...(razorpayPlanIdAnnual ? { razorpayPlanIdAnnual } : {}),
      },
    });
  }

  return { razorpayPlanIdMonthly, razorpayPlanIdAnnual, warnings };
}

/** @deprecated use createSubscriptionPlan(..., { kind: 'custom' }) */
export async function createCustomSubscriptionPlan(input: PlanWriteInput) {
  return createSubscriptionPlan(input, { kind: 'custom' });
}

export async function updateSubscriptionPlan(slug: string, input: PlanWriteInput) {
  const existing = await prisma.subscriptionPlan.findUnique({ where: { slug } });
  if (!existing) throw new Error('Plan not found');

  const features = normalizePlanFeatures(input.features);
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
    features: features as Prisma.InputJsonValue,
    ...(input.razorpayPlanIdMonthly !== undefined
      ? { razorpayPlanIdMonthly: input.razorpayPlanIdMonthly }
      : {}),
    ...(input.razorpayPlanIdAnnual !== undefined
      ? { razorpayPlanIdAnnual: input.razorpayPlanIdAnnual }
      : {}),
  };

  // Don't churn planCode on edit — uniqueness fights the same code
  return prisma.subscriptionPlan.update({ where: { slug }, data });
}

/** Shared plan → WorkspaceUsageLimits sync (admin assign + Razorpay verify/webhook). */
export async function syncWorkspaceLimitsFromPlanFeatures(
  workspaceId: string,
  features: PlanFeatures,
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  // ponytail: storageGb lives in plan.features only — gallery enforcement + usageLimits column later
  const campaignsLimit = campaignsLimitFromFeatures(features);

  return db.workspaceUsageLimits.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      contactsLimit: parseFeatureLimitForBackfill(features.contacts, 1000),
      teamMembersLimit: parseFeatureLimitForBackfill(features.teamMembers, 3),
      aiAgentsLimit: parseFeatureLimitForBackfill(features.aiAgents, 1),
      channelsLimit: channelsLimitFromLabel(features.channels, features.channelsUnlimited),
      aiTokensIncluded: 0,
      campaignsLimit,
      // ponytail: platform email = wallet CC only; emailsLimit unused for send gating
      emailsLimit: 0,
    },
    update: {
      contactsLimit: parseFeatureLimitForBackfill(features.contacts, 1000),
      teamMembersLimit: parseFeatureLimitForBackfill(features.teamMembers, 3),
      aiAgentsLimit: parseFeatureLimitForBackfill(features.aiAgents, 1),
      channelsLimit: channelsLimitFromLabel(features.channels, features.channelsUnlimited),
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
    razorpayPlanIdMonthly: plan.razorpayPlanIdMonthly ?? null,
    razorpayPlanIdAnnual: plan.razorpayPlanIdAnnual ?? null,
    emailsPerMonth: features.emailsPerMonth,
    walletCredits: features.walletCredits,
    // Top-level channels for PlanFeatureFlags UI gates (Integrations / tabs)
    channels: features.channels,
    aiCopilot: features.aiCopilot,
    socialListening: features.socialListening,
    voiceAgent: features.voiceAgent,
    developers: features.developers,
    whatsappPay: features.whatsappPay,
    ctwaAds: features.ctwaAds,
    reports: features.reports,
    messagesPerMonth: features.messagesPerMonth,
    storageGb: features.storageGb,
    apiAccess: features.apiAccess,
    customBranding: features.customBranding,
    prioritySupport: features.prioritySupport,
    channelsUnlimited: features.channelsUnlimited,
    aiReplies: features.aiReplies,
    campaigns: features.campaigns,
    integrations: features.integrations,
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

function formatStorageForLanding(value: PlanFeatures['storageGb']): string {
  if (value == null) return 'Custom';
  return `${value} GB`;
}

function buildLandingHighlights(features: PlanFeatures): string[] {
  const wallet = features.walletCredits ?? '—';
  const storage = formatStorageForLanding(features.storageGb);
  const seatsLine = `${features.teamMembers} seats · ${features.aiAgents} AI Agent${
    features.aiAgents === '1' ? '' : 's'
  }`;
  const lines: string[] = [features.channels, seatsLine];

  if (features.aiCopilot) lines.push('AI Copilot included');

  if (wallet === 'Custom') lines.push('Negotiated CC wallet');
  else if (wallet !== '—') lines.push(`${wallet} wallet`);

  lines.push(`${storage} storage`);

  if (features.ctwaAds) {
    lines.push('CTWA / Ads + Advanced reports + export');
  } else if (features.socialListening || features.voiceAgent || features.developers) {
    const bits = [
      features.socialListening ? 'Social Listening' : null,
      features.voiceAgent ? 'Voice' : null,
      features.developers ? 'Developers' : null,
      features.whatsappPay ? 'WhatsApp Pay' : null,
    ].filter(Boolean);
    if (bits.length) lines.push(bits.join(' · '));
    if (features.reports === 'Advanced') lines.push('Advanced reports');
  } else if (!features.aiCopilot) {
    lines.push('WhatsApp Automation journeys');
  }

  return lines;
}

/** Public landing / marketing payload (active public plans only). */
export function serializeLandingPlan(
  plan: Awaited<ReturnType<typeof listSubscriptionPlans>>[number]
) {
  const features = normalizePlanFeatures(plan.features as PlanFeatures);
  const customPrice =
    plan.priceMonthly == null ||
    plan.priceLabel?.toLowerCase() === 'custom' ||
    plan.priceMonthly === 0;

  const displayName =
    plan.name.trim() === plan.name.trim().toUpperCase()
      ? plan.name.charAt(0) + plan.name.slice(1).toLowerCase()
      : plan.name.trim() || planDisplayName(plan.slug);

  return {
    id: plan.slug,
    name: displayName,
    priceMonthly: plan.priceMonthly,
    priceLabel: plan.priceLabel ?? undefined,
    description: customPrice
      ? 'Unlimited scale, CTWA/Ads, and priority onboarding.'
      : `${features.channels} inbox and automation for your team.`,
    contactsSubtitle: 'Unlimited contacts',
    highlights: buildLandingHighlights(features),
    ctaText: customPrice ? 'Contact sales' : 'Start free trial',
    ctaKind: customPrice ? ('sales' as const) : ('trial' as const),
    isPopular: plan.popular,
    comparison: {
      contacts: 'Unlimited',
      overage: '—',
      channels: features.channels,
      seats: features.teamMembers,
      aiAgents: features.aiAgents,
      walletCredits: features.walletCredits ?? '—',
      aiCopilot: features.aiCopilot ?? false,
      socialListening: features.socialListening ?? false,
      voiceAgent: features.voiceAgent ?? false,
      developers: features.developers ?? false,
      whatsappPay: features.whatsappPay ?? false,
      ctwaAds: features.ctwaAds ?? false,
      reports: features.reports ?? 'Basic',
      storage: formatStorageForLanding(features.storageGb),
    },
  };
}

function parseEmailsPerMonthLimit(value: PlanFeatures['emailsPerMonth'], fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  if (value === 'unlimited' || value === 'custom') return UNLIMITED_USAGE_LIMIT;
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
        channelsLimit: channelsLimitFromLabel(features.channels, features.channelsUnlimited),
        aiTokensIncluded: 0,
        campaignsLimit: campaignsLimitFromFeatures(features),
        emailsLimit: 0,
      },
      update: {
        contactsLimit: parseFeatureLimitForBackfill(features.contacts, 1000),
        teamMembersLimit: parseFeatureLimitForBackfill(features.teamMembers, 3),
        aiAgentsLimit: parseFeatureLimitForBackfill(features.aiAgents, 1),
        channelsLimit: channelsLimitFromLabel(features.channels, features.channelsUnlimited),
        aiTokensIncluded: 0,
        campaignsLimit: campaignsLimitFromFeatures(features),
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
  if (normalized === 'unlimited' || normalized === 'custom') return UNLIMITED_USAGE_LIMIT;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
