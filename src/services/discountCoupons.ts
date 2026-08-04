import type { DiscountCoupon, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ccToDebitPaise } from './usageCost.constants.js';
import { creditWallet } from './wallet.service.js';

export type CouponUiStatus = 'active' | 'paused' | 'expired' | 'scheduled';

export type SerializedDiscountCoupon = {
  id: string;
  code: string;
  discountPercent: number;
  maxDiscountAmountPaise: number | null;
  validFrom: string;
  validUntil: string;
  maxRedemptions: number;
  redemptionCount: number;
  uniqueWorkspaceCount: number;
  minOrderAmountPaise: number | null;
  applicablePlanSlugs: string[];
  bonusWalletCreditsCc: number | null;
  isActive: boolean;
  status: CouponUiStatus;
  usesRemaining: number;
  createdAt: string;
  updatedAt: string;
};

/** Self-serve checkout plans eligible for coupon scoping in super-admin. */
export const COUPON_SELF_SERVE_PLAN_SLUGS = ['starter', 'growth', 'business'] as const;

export type CouponSelfServePlanSlug = (typeof COUPON_SELF_SERVE_PLAN_SLUGS)[number];

export function normalizeApplicablePlanSlugs(slugs: string[] | undefined | null): string[] {
  if (!slugs?.length) return [];
  const normalized = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const allowed = new Set<string>(COUPON_SELF_SERVE_PLAN_SLUGS);
  const invalid = normalized.filter((s) => !allowed.has(s));
  if (invalid.length) {
    throw new Error(`Invalid plan slug(s): ${invalid.join(', ')}`);
  }
  return normalized;
}

/** Empty applicablePlanSlugs = all plans (backward compatible). */
export function isCouponApplicableToPlan(
  coupon: Pick<DiscountCoupon, 'applicablePlanSlugs'>,
  planSlug: string
): boolean {
  if (!coupon.applicablePlanSlugs.length) return true;
  return coupon.applicablePlanSlugs.includes(planSlug.trim().toLowerCase());
}

export function formatApplicablePlanLabels(slugs: string[]): string {
  if (!slugs.length) return 'All plans';
  const labels: Record<string, string> = {
    starter: 'Starter',
    growth: 'Growth',
    business: 'Business',
  };
  return slugs.map((s) => labels[s] ?? s).join(', ');
}

export type SerializedDiscountCouponRedemption = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  discountAmountPaise: number;
  invoiceId: string;
  createdAt: string;
};

export type DiscountCouponDetail = SerializedDiscountCoupon & {
  redemptions: SerializedDiscountCouponRedemption[];
};

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Razorpay / plan checkout minimum (₹1). */
export const MIN_CHECKOUT_AMOUNT_PAISE = 100;

/** Payable amount after coupon discount, never below MIN_CHECKOUT_AMOUNT_PAISE. */
export function computeFinalAmountPaise(orderAmountPaise: number, discountPaise: number): number {
  return Math.max(MIN_CHECKOUT_AMOUNT_PAISE, orderAmountPaise - discountPaise);
}

/** Percent off order, capped by maxDiscountAmountPaise when set. */
export function computeDiscountPaise(
  orderAmountPaise: number,
  discountPercent: number,
  maxDiscountAmountPaise: number | null
): number {
  if (orderAmountPaise <= 0 || discountPercent <= 0) return 0;
  const pctOff = Math.floor((orderAmountPaise * discountPercent) / 100);
  if (maxDiscountAmountPaise == null || maxDiscountAmountPaise <= 0) return pctOff;
  return Math.min(pctOff, maxDiscountAmountPaise);
}

export function deriveCouponStatus(
  coupon: Pick<
    DiscountCoupon,
    'isActive' | 'validFrom' | 'validUntil' | 'maxRedemptions' | 'redemptionCount'
  >,
  at = new Date()
): CouponUiStatus {
  if (!coupon.isActive) return 'paused';
  if (coupon.validFrom > at) return 'scheduled';
  if (coupon.validUntil < at || coupon.redemptionCount >= coupon.maxRedemptions) return 'expired';
  return 'active';
}

export function serializeDiscountCoupon(
  coupon: DiscountCoupon,
  uniqueWorkspaceCount = 0
): SerializedDiscountCoupon {
  const status = deriveCouponStatus(coupon);
  return {
    id: coupon.id,
    code: coupon.code,
    discountPercent: coupon.discountPercent,
    maxDiscountAmountPaise: coupon.maxDiscountAmountPaise,
    validFrom: coupon.validFrom.toISOString(),
    validUntil: coupon.validUntil.toISOString(),
    maxRedemptions: coupon.maxRedemptions,
    redemptionCount: coupon.redemptionCount,
    uniqueWorkspaceCount,
    minOrderAmountPaise: coupon.minOrderAmountPaise,
    applicablePlanSlugs: coupon.applicablePlanSlugs,
    bonusWalletCreditsCc: coupon.bonusWalletCreditsCc,
    isActive: coupon.isActive,
    status,
    usesRemaining: Math.max(0, coupon.maxRedemptions - coupon.redemptionCount),
    createdAt: coupon.createdAt.toISOString(),
    updatedAt: coupon.updatedAt.toISOString(),
  };
}

/** ponytail: O(n) over distinct coupon+workspace pairs; fine at platform coupon scale. */
export function countUniqueWorkspacesByCoupon(
  pairs: { couponId: string; workspaceId: string }[]
): Map<string, number> {
  const counts = new Map<string, Set<string>>();
  for (const { couponId, workspaceId } of pairs) {
    let workspaces = counts.get(couponId);
    if (!workspaces) {
      workspaces = new Set();
      counts.set(couponId, workspaces);
    }
    workspaces.add(workspaceId);
  }
  return new Map([...counts.entries()].map(([couponId, workspaces]) => [couponId, workspaces.size]));
}

async function loadUniqueWorkspaceCounts(): Promise<Map<string, number>> {
  const pairs = await prisma.discountCouponRedemption.findMany({
    select: { couponId: true, workspaceId: true },
    distinct: ['couponId', 'workspaceId'],
  });
  return countUniqueWorkspacesByCoupon(pairs);
}

export async function listDiscountCoupons() {
  const [rows, uniqueCounts] = await Promise.all([
    prisma.discountCoupon.findMany({ orderBy: { createdAt: 'desc' } }),
    loadUniqueWorkspaceCounts(),
  ]);
  return rows.map((row) => serializeDiscountCoupon(row, uniqueCounts.get(row.id) ?? 0));
}

export async function getDiscountCouponDetail(id: string): Promise<DiscountCouponDetail | null> {
  const coupon = await prisma.discountCoupon.findUnique({ where: { id } });
  if (!coupon) return null;

  const [uniqueWorkspaceCount, redemptions] = await Promise.all([
    prisma.discountCouponRedemption.findMany({
      where: { couponId: id },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
    }).then((rows) => rows.length),
    prisma.discountCouponRedemption.findMany({
      where: { couponId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
      },
    }),
  ]);

  return {
    ...serializeDiscountCoupon(coupon, uniqueWorkspaceCount),
    redemptions: redemptions.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      workspaceName: row.workspace.name,
      workspaceSlug: row.workspace.slug,
      discountAmountPaise: row.discountAmountPaise,
      invoiceId: row.invoiceId,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export type CreateDiscountCouponInput = {
  code: string;
  discountPercent: number;
  maxDiscountAmountPaise?: number | null;
  validFrom: Date;
  validUntil: Date;
  maxRedemptions: number;
  minOrderAmountPaise?: number | null;
  applicablePlanSlugs?: string[];
  bonusWalletCreditsCc?: number | null;
  isActive?: boolean;
};

export type UpdateDiscountCouponInput = Partial<
  Omit<CreateDiscountCouponInput, 'code'> & { code: string }
>;

function assertCouponDates(validFrom: Date, validUntil: Date) {
  if (validUntil < validFrom) {
    throw new Error('Valid until must be on or after valid from');
  }
}

function assertCouponNumbers(input: {
  discountPercent: number;
  maxDiscountAmountPaise?: number | null;
  maxRedemptions: number;
  minOrderAmountPaise?: number | null;
  bonusWalletCreditsCc?: number | null;
}) {
  if (input.discountPercent < 0 || input.discountPercent > 100) {
    throw new Error('Discount percent must be between 0 and 100');
  }
  if (input.maxDiscountAmountPaise != null && input.maxDiscountAmountPaise < 0) {
    throw new Error('Max discount amount must be zero or greater');
  }
  if (input.maxRedemptions < 1) {
    throw new Error('Max redemptions must be at least 1');
  }
  if (input.minOrderAmountPaise != null && input.minOrderAmountPaise < 0) {
    throw new Error('Minimum order amount must be zero or greater');
  }
  if (input.bonusWalletCreditsCc != null && input.bonusWalletCreditsCc < 0) {
    throw new Error('Bonus ConvoCoins must be zero or greater');
  }
}

export async function createDiscountCoupon(input: CreateDiscountCouponInput) {
  const code = normalizeCouponCode(input.code);
  if (!code) throw new Error('Coupon code is required');
  assertCouponDates(input.validFrom, input.validUntil);
  assertCouponNumbers(input);

  const applicablePlanSlugs = normalizeApplicablePlanSlugs(input.applicablePlanSlugs);
  const bonusWalletCreditsCc =
    input.bonusWalletCreditsCc != null && input.bonusWalletCreditsCc > 0
      ? input.bonusWalletCreditsCc
      : null;

  const row = await prisma.discountCoupon.create({
    data: {
      code,
      discountPercent: input.discountPercent,
      maxDiscountAmountPaise: input.maxDiscountAmountPaise ?? null,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      maxRedemptions: input.maxRedemptions,
      minOrderAmountPaise: input.minOrderAmountPaise ?? null,
      applicablePlanSlugs,
      bonusWalletCreditsCc,
      isActive: input.isActive ?? true,
    },
  });
  return serializeDiscountCoupon(row);
}

export async function updateDiscountCoupon(id: string, input: UpdateDiscountCouponInput) {
  const existing = await prisma.discountCoupon.findUnique({ where: { id } });
  if (!existing) throw new Error('Coupon not found');

  const validFrom = input.validFrom ?? existing.validFrom;
  const validUntil = input.validUntil ?? existing.validUntil;
  assertCouponDates(validFrom, validUntil);
  assertCouponNumbers({
    discountPercent: input.discountPercent ?? existing.discountPercent,
    maxDiscountAmountPaise:
      input.maxDiscountAmountPaise !== undefined
        ? input.maxDiscountAmountPaise
        : existing.maxDiscountAmountPaise,
    maxRedemptions: input.maxRedemptions ?? existing.maxRedemptions,
    minOrderAmountPaise:
      input.minOrderAmountPaise !== undefined
        ? input.minOrderAmountPaise
        : existing.minOrderAmountPaise,
    bonusWalletCreditsCc:
      input.bonusWalletCreditsCc !== undefined
        ? input.bonusWalletCreditsCc
        : existing.bonusWalletCreditsCc,
  });

  const applicablePlanSlugs =
    input.applicablePlanSlugs !== undefined
      ? normalizeApplicablePlanSlugs(input.applicablePlanSlugs)
      : existing.applicablePlanSlugs;
  const bonusWalletCreditsCc =
    input.bonusWalletCreditsCc !== undefined
      ? input.bonusWalletCreditsCc != null && input.bonusWalletCreditsCc > 0
        ? input.bonusWalletCreditsCc
        : null
      : existing.bonusWalletCreditsCc;

  const row = await prisma.discountCoupon.update({
    where: { id },
    data: {
      ...(input.code != null ? { code: normalizeCouponCode(input.code) } : {}),
      ...(input.discountPercent != null ? { discountPercent: input.discountPercent } : {}),
      ...(input.maxDiscountAmountPaise !== undefined
        ? { maxDiscountAmountPaise: input.maxDiscountAmountPaise }
        : {}),
      ...(input.validFrom != null ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil != null ? { validUntil: input.validUntil } : {}),
      ...(input.maxRedemptions != null ? { maxRedemptions: input.maxRedemptions } : {}),
      ...(input.minOrderAmountPaise !== undefined
        ? { minOrderAmountPaise: input.minOrderAmountPaise }
        : {}),
      ...(input.applicablePlanSlugs !== undefined ? { applicablePlanSlugs } : {}),
      ...(input.bonusWalletCreditsCc !== undefined ? { bonusWalletCreditsCc } : {}),
      ...(input.isActive != null ? { isActive: input.isActive } : {}),
    },
  });
  return serializeDiscountCoupon(row);
}

export async function setDiscountCouponActive(id: string, isActive: boolean) {
  const existing = await prisma.discountCoupon.findUnique({ where: { id } });
  if (!existing) throw new Error('Coupon not found');
  const row = await prisma.discountCoupon.update({ where: { id }, data: { isActive } });
  return serializeDiscountCoupon(row);
}

export type ValidateCouponResult =
  | {
      valid: true;
      couponId: string;
      code: string;
      discountPercent: number;
      maxDiscountAmountPaise: number | null;
      discountPaise: number;
      finalAmountPaise: number;
      originalAmountPaise: number;
    }
  | { valid: false; reason: string };

export async function validateDiscountCoupon(params: {
  code: string;
  amountPaise: number;
  planSlug?: string;
  at?: Date;
}): Promise<ValidateCouponResult> {
  const normalized = normalizeCouponCode(params.code);
  if (!normalized) return { valid: false, reason: 'Coupon code is required' };
  if (params.amountPaise <= 0) return { valid: false, reason: 'Order amount must be positive' };

  const coupon = await prisma.discountCoupon.findUnique({ where: { code: normalized } });
  if (!coupon) return { valid: false, reason: 'Invalid coupon code' };

  const at = params.at ?? new Date();
  const status = deriveCouponStatus(coupon, at);
  if (status === 'paused') return { valid: false, reason: 'This coupon is not active' };
  if (status === 'scheduled') return { valid: false, reason: 'This coupon is not valid yet' };
  if (status === 'expired') return { valid: false, reason: 'This coupon has expired' };

  if (coupon.applicablePlanSlugs.length) {
    if (!params.planSlug) {
      return { valid: false, reason: 'This coupon requires a plan to be selected' };
    }
    if (!isCouponApplicableToPlan(coupon, params.planSlug)) {
      return { valid: false, reason: 'This coupon does not apply to the selected plan' };
    }
  }

  if (coupon.minOrderAmountPaise != null && params.amountPaise < coupon.minOrderAmountPaise) {
    return { valid: false, reason: 'Order amount does not meet the minimum for this coupon' };
  }

  const discountPaise = computeDiscountPaise(
    params.amountPaise,
    coupon.discountPercent,
    coupon.maxDiscountAmountPaise
  );
  if (discountPaise <= 0) {
    return { valid: false, reason: 'This coupon does not apply to this order' };
  }

  const finalAmountPaise = computeFinalAmountPaise(params.amountPaise, discountPaise);
  return {
    valid: true,
    couponId: coupon.id,
    code: coupon.code,
    discountPercent: coupon.discountPercent,
    maxDiscountAmountPaise: coupon.maxDiscountAmountPaise,
    discountPaise: params.amountPaise - finalAmountPaise,
    finalAmountPaise,
    originalAmountPaise: params.amountPaise,
  };
}

type CouponRedemptionTx = Pick<typeof prisma, 'discountCoupon' | 'discountCouponRedemption'>;

export type RecordCouponRedemptionParams = {
  couponId: string;
  workspaceId: string;
  discountAmountPaise: number;
  invoiceId: string;
  /** When backfilling ledger rows for invoices already counted in redemptionCount. */
  incrementCount?: boolean;
  createdAt?: Date;
};

export async function recordCouponRedemption(
  params: RecordCouponRedemptionParams,
  tx: CouponRedemptionTx = prisma
) {
  const existing = await tx.discountCouponRedemption.findUnique({
    where: { invoiceId: params.invoiceId },
  });
  if (existing) return true;

  const coupon = await tx.discountCoupon.findUnique({ where: { id: params.couponId } });
  if (!coupon) return false;
  const incrementCount = params.incrementCount !== false;
  if (incrementCount && coupon.redemptionCount >= coupon.maxRedemptions) return false;

  await tx.discountCouponRedemption.create({
    data: {
      couponId: params.couponId,
      workspaceId: params.workspaceId,
      discountAmountPaise: params.discountAmountPaise,
      invoiceId: params.invoiceId,
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    },
  });
  if (incrementCount) {
    await tx.discountCoupon.update({
      where: { id: params.couponId },
      data: { redemptionCount: { increment: 1 } },
    });
  }
  return true;
}

export function couponBonusIdempotencyKey(invoiceId: string) {
  return `coupon-bonus:${invoiceId}`;
}

/** Idempotent bonus CC credit when a plan-scoped coupon is redeemed. */
export async function creditCouponBonusWalletCredits(params: {
  couponId: string;
  workspaceId: string;
  invoiceId: string;
  tx?: Prisma.TransactionClient;
}) {
  const db = params.tx ?? prisma;
  const coupon = await db.discountCoupon.findUnique({ where: { id: params.couponId } });
  if (!coupon?.bonusWalletCreditsCc || coupon.bonusWalletCreditsCc <= 0) return null;

  return creditWallet({
    workspaceId: params.workspaceId,
    amountPaise: ccToDebitPaise(coupon.bonusWalletCreditsCc),
    category: 'adjustment',
    description: `Coupon bonus ConvoCoins — ${coupon.code} (${coupon.bonusWalletCreditsCc} CC)`,
    referenceType: 'coupon_bonus',
    referenceId: params.invoiceId,
    idempotencyKey: couponBonusIdempotencyKey(params.invoiceId),
    tx: params.tx,
  });
}

/** Extract coupon code from plan invoice description: "Starter plan (monthly) · WELCOME". */
export function parseCouponCodeFromInvoiceDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const sep = description.lastIndexOf(' · ');
  if (sep < 0) return null;
  const code = normalizeCouponCode(description.slice(sep + 3));
  return code || null;
}

type PlanPurchaseCouponMeta = {
  couponId?: string;
  couponCode?: string;
  discountPaise?: number;
  originalAmountPaise?: number;
};

function readPlanPurchaseCouponMeta(metadata: unknown): PlanPurchaseCouponMeta {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const meta = metadata as Record<string, unknown>;
  return {
    couponId: typeof meta.couponId === 'string' ? meta.couponId : undefined,
    couponCode: typeof meta.couponCode === 'string' ? meta.couponCode : undefined,
    discountPaise: typeof meta.discountPaise === 'number' ? meta.discountPaise : undefined,
    originalAmountPaise:
      typeof meta.originalAmountPaise === 'number' ? meta.originalAmountPaise : undefined,
  };
}

/** Backfill ledger rows from paid plan_purchase invoices that used a coupon. Idempotent via invoiceId. */
export async function backfillCouponRedemptionsFromInvoices() {
  const [invoices, coupons] = await Promise.all([
    prisma.billingInvoice.findMany({
      where: { type: 'plan_purchase', status: 'paid' },
      select: {
        id: true,
        workspaceId: true,
        description: true,
        metadata: true,
        amountPaise: true,
        paidAt: true,
      },
    }),
    prisma.discountCoupon.findMany({ select: { id: true, code: true } }),
  ]);

  const couponIdByCode = new Map(coupons.map((c) => [c.code, c.id]));
  let created = 0;
  let skipped = 0;
  let unmatched = 0;

  for (const invoice of invoices) {
    const meta = readPlanPurchaseCouponMeta(invoice.metadata);
    let couponId = meta.couponId;
    if (!couponId) {
      const code =
        (meta.couponCode ? normalizeCouponCode(meta.couponCode) : null) ??
        parseCouponCodeFromInvoiceDescription(invoice.description);
      couponId = code ? couponIdByCode.get(code) : undefined;
    }
    if (!couponId) {
      unmatched++;
      continue;
    }

    const existing = await prisma.discountCouponRedemption.findUnique({
      where: { invoiceId: invoice.id },
    });
    if (existing) {
      skipped++;
      continue;
    }

    const discountAmountPaise =
      meta.discountPaise ??
      (meta.originalAmountPaise != null
        ? Math.max(0, meta.originalAmountPaise - invoice.amountPaise)
        : 0);

    const ok = await recordCouponRedemption(
      {
        couponId,
        workspaceId: invoice.workspaceId,
        discountAmountPaise,
        invoiceId: invoice.id,
        incrementCount: false,
        createdAt: invoice.paidAt ?? undefined,
      },
      prisma
    );
    if (ok) created++;
    else skipped++;
  }

  return { created, skipped, unmatched, scanned: invoices.length };
}

/** @deprecated use recordCouponRedemption */
export async function incrementCouponRedemption(
  couponId: string,
  tx: Pick<typeof prisma, 'discountCoupon'> = prisma
) {
  const coupon = await tx.discountCoupon.findUnique({ where: { id: couponId } });
  if (!coupon || coupon.redemptionCount >= coupon.maxRedemptions) return false;
  await tx.discountCoupon.update({
    where: { id: couponId },
    data: { redemptionCount: { increment: 1 } },
  });
  return true;
}
