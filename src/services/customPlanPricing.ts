import type { Prisma } from '@prisma/client';
import { listSubscriptionPlans, type PlanFeatures } from './subscriptionPlans.js';

export const CUSTOM_PLAN_PRICING_RULES = {
  currency: 'USD',
  baseMonthly: 29,
  minMonthly: 29,
  annualDiscountMonths: 2,
  included: {
    contacts: 1_000,
    aiAgents: 1,
    teamMembers: 2,
    channels: 2,
    emails: 1_000,
  },
  rates: {
    contactsPer1000: 3,
    aiAgent: 5,
    teamMember: 1,
    channel: 2,
    emailsPer1000: 1,
  },
  limits: {
    contacts: { min: 1_000, max: 100_000, step: 1_000 },
    aiAgents: { min: 1, max: 50, step: 1 },
    teamMembers: { min: 1, max: 100, step: 1 },
    channels: { min: 1, max: 20, step: 1 },
    emails: { min: 1_000, max: 500_000, step: 1_000 },
  },
  defaults: {
    contacts: 5_000,
    aiAgents: 3,
    teamMembers: 5,
    channels: 3,
    emails: 5_000,
  },
  enterpriseThreshold: {
    contacts: 50_000,
    monthly: 750,
  },
} as const;

export type CustomPlanInput = {
  contacts: number;
  aiAgents: number;
  teamMembers: number;
  channels: number;
  emails: number;
};

export type CustomPlanBreakdownLine = {
  key: string;
  label: string;
  quantity?: number;
  unitLabel?: string;
  amount: number;
};

export type CustomPlanQuote = {
  contacts: number;
  aiAgents: number;
  teamMembers: number;
  channels: number;
  emails: number;
  monthlyTotal: number;
  annualTotal: number;
  currency: string;
  breakdown: CustomPlanBreakdownLine[];
  matchedPlanSlug: string | null;
  matchedPlanName: string | null;
  requiresSales: boolean;
  savedAt: string | null;
};

function parseFeatureNumber(value: string | number | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const normalized = value.replace(/,/g, '').trim().toLowerCase();
  if (normalized === 'unlimited' || normalized === 'custom') return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function quantityBlocks(quantity: number, included: number, blockSize = 1000) {
  const extra = Math.max(0, quantity - included);
  return Math.ceil(extra / blockSize);
}

export function calculateCustomPlanQuote(
  input: CustomPlanInput,
  savedAt: string | null = null
): CustomPlanQuote {
  const rules = CUSTOM_PLAN_PRICING_RULES;
  const { included, rates, baseMonthly, minMonthly } = rules;

  const contactBlocks = quantityBlocks(input.contacts, included.contacts);
  const emailBlocks = quantityBlocks(input.emails, included.emails);
  const extraAgents = Math.max(0, input.aiAgents - included.aiAgents);
  const extraTeam = Math.max(0, input.teamMembers - included.teamMembers);
  const extraChannels = Math.max(0, input.channels - included.channels);

  const contactCost = contactBlocks * rates.contactsPer1000;
  const emailCost = emailBlocks * rates.emailsPer1000;
  const agentCost = extraAgents * rates.aiAgent;
  const teamCost = extraTeam * rates.teamMember;
  const channelCost = extraChannels * rates.channel;

  const breakdown: CustomPlanBreakdownLine[] = [
    { key: 'base', label: 'Platform base', amount: baseMonthly },
  ];

  if (contactBlocks > 0) {
    breakdown.push({
      key: 'contacts',
      label: 'Contacts',
      quantity: input.contacts,
      unitLabel: 'contacts',
      amount: contactCost,
    });
  }

  if (extraAgents > 0) {
    breakdown.push({
      key: 'aiAgents',
      label: 'AI agents',
      quantity: extraAgents,
      unitLabel: `× $${rates.aiAgent}`,
      amount: agentCost,
    });
  }

  if (extraTeam > 0) {
    breakdown.push({
      key: 'teamMembers',
      label: 'Team members',
      quantity: extraTeam,
      unitLabel: `× $${rates.teamMember}`,
      amount: teamCost,
    });
  }

  if (extraChannels > 0) {
    breakdown.push({
      key: 'channels',
      label: 'Channels',
      quantity: extraChannels,
      unitLabel: `× $${rates.channel}`,
      amount: channelCost,
    });
  }

  if (emailBlocks > 0) {
    breakdown.push({
      key: 'emails',
      label: 'Email sends (Resend)',
      quantity: input.emails,
      unitLabel: 'emails / mo',
      amount: emailCost,
    });
  }

  const subtotal = breakdown.reduce((sum, line) => sum + line.amount, 0);
  const monthlyTotal = Math.max(minMonthly, subtotal);
  const annualTotal = monthlyTotal * (12 - rules.annualDiscountMonths);

  const requiresSales =
    input.contacts >= rules.enterpriseThreshold.contacts ||
    monthlyTotal >= rules.enterpriseThreshold.monthly;

  return {
    ...input,
    monthlyTotal,
    annualTotal,
    currency: rules.currency,
    breakdown,
    matchedPlanSlug: null,
    matchedPlanName: null,
    requiresSales,
    savedAt,
  };
}

function planCapacityScore(features: PlanFeatures, input: CustomPlanInput) {
  const contacts = parseFeatureNumber(features.contacts) ?? Number.MAX_SAFE_INTEGER;
  const aiAgents = parseFeatureNumber(features.aiAgents) ?? Number.MAX_SAFE_INTEGER;
  const teamMembers = parseFeatureNumber(features.teamMembers) ?? Number.MAX_SAFE_INTEGER;
  const channels =
    features.channelsUnlimited || features.channels.toLowerCase() === 'unlimited'
      ? Number.MAX_SAFE_INTEGER
      : (parseFeatureNumber(features.channels) ?? Number.MAX_SAFE_INTEGER);
  const emails = parseFeatureNumber(features.emailsPerMonth) ?? Number.MAX_SAFE_INTEGER;

  const deficits = [
    Math.max(0, input.contacts - contacts),
    Math.max(0, input.aiAgents - aiAgents),
    Math.max(0, input.teamMembers - teamMembers),
    Math.max(0, input.channels - channels),
    Math.max(0, input.emails - emails),
  ];

  return deficits.reduce((sum, value) => sum + value, 0);
}

export async function matchCustomQuoteToPlan(quote: CustomPlanQuote) {
  const plans = await listSubscriptionPlans();
  const purchasable = plans.filter((p) => p.slug !== 'enterprise' && p.priceMonthly != null);

  let best: (typeof purchasable)[number] | null = null;
  let bestScore = Number.MAX_SAFE_INTEGER;

  for (const plan of purchasable) {
    const features = plan.features as PlanFeatures;
    const score = planCapacityScore(features, quote);
    if (score < bestScore) {
      bestScore = score;
      best = plan;
    }
  }

  if (!best || bestScore > 0) {
    return { slug: null as string | null, name: null as string | null };
  }

  return { slug: best.slug, name: best.name };
}

export async function buildCustomPlanQuote(
  input: CustomPlanInput,
  savedAt: string | null = null
) {
  const quote = calculateCustomPlanQuote(input, savedAt);
  const match = await matchCustomQuoteToPlan(quote);
  return {
    ...quote,
    matchedPlanSlug: match.slug,
    matchedPlanName: match.name,
  };
}

export function readCustomPlanInput(
  value: Prisma.JsonValue | null | undefined
): { input: CustomPlanInput; savedAt: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.contacts !== 'number' ||
    typeof record.aiAgents !== 'number' ||
    typeof record.teamMembers !== 'number' ||
    typeof record.channels !== 'number'
  ) {
    return null;
  }

  return {
    input: {
      contacts: record.contacts,
      aiAgents: record.aiAgents,
      teamMembers: record.teamMembers,
      channels: record.channels,
      emails:
        typeof record.emails === 'number'
          ? record.emails
          : CUSTOM_PLAN_PRICING_RULES.defaults.emails,
    },
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : null,
  };
}

export function serializeCustomPlanSelection(quote: CustomPlanQuote): Prisma.InputJsonValue {
  return {
    contacts: quote.contacts,
    aiAgents: quote.aiAgents,
    teamMembers: quote.teamMembers,
    channels: quote.channels,
    emails: quote.emails,
    monthlyTotal: quote.monthlyTotal,
    annualTotal: quote.annualTotal,
    currency: quote.currency,
    breakdown: quote.breakdown,
    matchedPlanSlug: quote.matchedPlanSlug,
    matchedPlanName: quote.matchedPlanName,
    requiresSales: quote.requiresSales,
    savedAt: quote.savedAt ?? new Date().toISOString(),
  };
}
