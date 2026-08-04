import type Razorpay from 'razorpay';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';

export type PlanSlug = 'starter' | 'growth' | 'business' | 'enterprise';

type RazorpayPlanItem = {
  id: string;
  period: string;
  interval: number;
  item?: { amount?: number; currency?: string; name?: string };
};

const SLUGS: PlanSlug[] = ['starter', 'growth', 'business', 'enterprise'];

/** Plan IDs from env override API matching. */
export function razorpayPlanIdsFromEnv(slug: PlanSlug): {
  monthly: string | null;
  annual: string | null;
} {
  const upper = slug.toUpperCase();
  return {
    monthly: process.env[`RAZORPAY_PLAN_${upper}_MONTHLY`]?.trim() || null,
    annual: process.env[`RAZORPAY_PLAN_${upper}_ANNUAL`]?.trim() || null,
  };
}

const LEGACY_PLACEHOLDER_PLAN_IDS = new Set([
  'plan_starter_monthly',
  'plan_starter_annual',
  'plan_growth_monthly',
  'plan_growth_annual',
  'plan_pro_monthly',
  'plan_pro_annual',
]);

export function isValidRazorpayPlanId(id: string | null | undefined): id is string {
  if (!id?.startsWith('plan_')) return false;
  if (LEGACY_PLACEHOLDER_PLAN_IDS.has(id)) return false;
  // Razorpay dashboard IDs look like plan_T1QBhPUbVM5Sql
  return /^plan_[A-Z][A-Za-z0-9]+$/.test(id);
}

async function fetchAllRazorpayPlans(client: Razorpay): Promise<RazorpayPlanItem[]> {
  const plans: RazorpayPlanItem[] = [];
  let skip = 0;
  const count = 100;

  for (;;) {
    const page = (await client.plans.all({ count, skip })) as {
      items?: RazorpayPlanItem[];
    };
    const items = page.items ?? [];
    plans.push(...items);
    if (items.length < count) break;
    skip += count;
    if (skip > 500) break;
  }

  return plans;
}

function matchPlanByAmount(
  remotePlans: RazorpayPlanItem[],
  amountPaise: number | null,
  cycle: 'monthly' | 'annual'
): string | null {
  if (!amountPaise) return null;

  const period = cycle === 'annual' ? 'yearly' : 'monthly';
  const matches = remotePlans.filter(
    (p) =>
      p.period === period &&
      p.interval === 1 &&
      p.item?.currency === 'INR' &&
      p.item?.amount === amountPaise
  );

  if (matches.length === 0) return null;
  return matches[matches.length - 1]!.id;
}

function matchPlanByName(
  remotePlans: RazorpayPlanItem[],
  planName: string,
  cycle: 'monthly' | 'annual'
): string | null {
  const period = cycle === 'annual' ? 'yearly' : 'monthly';
  const target = planName.toUpperCase().trim();
  const matches = remotePlans.filter((p) => {
    if (p.period !== period || p.interval !== 1) return false;
    const name = p.item?.name?.toUpperCase().trim() ?? '';
    return name === target || name.includes(target);
  });
  if (matches.length === 0) return null;
  return matches[matches.length - 1]!.id;
}

function amountForRemotePlan(
  remotePlans: RazorpayPlanItem[],
  planId: string
): number | null {
  const plan = remotePlans.find((p) => p.id === planId);
  return plan?.item?.amount ?? null;
}

export type RazorpayPlanSyncResult = {
  updated: Array<{
    slug: string;
    razorpayPlanIdMonthly: string | null;
    razorpayPlanIdAnnual: string | null;
    source: { monthly: 'env' | 'api' | 'unchanged'; annual: 'env' | 'api' | 'unchanged' };
  }>;
};

/**
 * Links ConvoSync subscription plans to Razorpay plan IDs using env overrides,
 * then amount+period matching against the Razorpay Plans API.
 */
export async function syncRazorpayPlanIds(client?: Razorpay | null): Promise<RazorpayPlanSyncResult> {
  const result: RazorpayPlanSyncResult = { updated: [] };

  let remotePlans: RazorpayPlanItem[] = [];
  if (client && config.razorpay.enabled) {
    try {
      remotePlans = await fetchAllRazorpayPlans(client);
    } catch {
      remotePlans = [];
    }
  }

  const dbPlans = await prisma.subscriptionPlan.findMany({
    where: { slug: { in: SLUGS }, isActive: true },
  });

  for (const dbPlan of dbPlans) {
    const slug = dbPlan.slug as PlanSlug;
    const fromEnv = razorpayPlanIdsFromEnv(slug);

    let monthly = isValidRazorpayPlanId(fromEnv.monthly) ? fromEnv.monthly : null;
    let annual = isValidRazorpayPlanId(fromEnv.annual) ? fromEnv.annual : null;
    const source: RazorpayPlanSyncResult['updated'][number]['source'] = {
      monthly: 'unchanged',
      annual: 'unchanged',
    };

    if (monthly) source.monthly = 'env';
    else if (!isValidRazorpayPlanId(dbPlan.razorpayPlanIdMonthly)) {
      const matched =
        matchPlanByAmount(remotePlans, dbPlan.priceMonthlyPaise, 'monthly') ??
        matchPlanByName(remotePlans, dbPlan.name, 'monthly');
      if (matched) {
        monthly = matched;
        source.monthly = 'api';
      }
    }

    if (annual) source.annual = 'env';
    else if (!isValidRazorpayPlanId(dbPlan.razorpayPlanIdAnnual)) {
      const matched =
        matchPlanByAmount(remotePlans, dbPlan.priceAnnualPaise, 'annual') ??
        matchPlanByName(remotePlans, dbPlan.name, 'annual');
      if (matched) {
        annual = matched;
        source.annual = 'api';
      }
    }

    const data: {
      razorpayPlanIdMonthly?: string | null;
      razorpayPlanIdAnnual?: string | null;
      priceMonthlyPaise?: number;
      priceAnnualPaise?: number;
    } = {};
    if (monthly && monthly !== dbPlan.razorpayPlanIdMonthly) {
      data.razorpayPlanIdMonthly = monthly;
    } else if (!monthly && !isValidRazorpayPlanId(dbPlan.razorpayPlanIdMonthly)) {
      data.razorpayPlanIdMonthly = null;
    }

    if (annual && annual !== dbPlan.razorpayPlanIdAnnual) {
      data.razorpayPlanIdAnnual = annual;
    } else if (!annual && !isValidRazorpayPlanId(dbPlan.razorpayPlanIdAnnual)) {
      data.razorpayPlanIdAnnual = null;
    }
    if (monthly && source.monthly === 'api') {
      const amount = amountForRemotePlan(remotePlans, monthly);
      if (amount && amount !== dbPlan.priceMonthlyPaise) {
        data.priceMonthlyPaise = amount;
      }
    }
    if (annual && source.annual === 'api') {
      const amount = amountForRemotePlan(remotePlans, annual);
      if (amount && amount !== dbPlan.priceAnnualPaise) {
        data.priceAnnualPaise = amount;
      }
    }

    if (Object.keys(data).length === 0) continue;

    const updated = await prisma.subscriptionPlan.update({
      where: { id: dbPlan.id },
      data,
    });

    result.updated.push({
      slug: updated.slug,
      razorpayPlanIdMonthly: updated.razorpayPlanIdMonthly,
      razorpayPlanIdAnnual: updated.razorpayPlanIdAnnual,
      source,
    });
  }

  return result;
}

export function logRazorpayPlanSync(result: RazorpayPlanSyncResult, log: (msg: string) => void) {
  if (result.updated.length === 0) {
    log('Razorpay plan sync: all plans already linked (or no matches found)');
    return;
  }
  for (const row of result.updated) {
    log(
      `Razorpay plan sync: ${row.slug} → monthly=${row.razorpayPlanIdMonthly ?? '—'} (${row.source.monthly}), annual=${row.razorpayPlanIdAnnual ?? '—'} (${row.source.annual})`
    );
  }
}
