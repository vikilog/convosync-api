import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import { resolveCheckoutRazorpayPlanId } from './razorpayPlanSync.js';
import {
  minCheckoutMinor,
  planAmountMinor,
  type BillingCurrency,
} from './billingCurrency.js';
import { ensureRazorpayCustomer, getWorkspaceRazorpayContact } from './razorpayCustomer.service.js';
import { paidActivationWorkspaceFields } from './trial.js';
import {
  syncWorkspaceLimitsFromPlanFeatures,
  type PlanFeatures,
} from './subscriptionPlans.js';
import {
  extractRazorpayErrorDetails,
  normalizeRazorpayError,
} from '../utils/razorpay-error.utils.js';
import {
  resolveOfferCheckoutKind,
  type BillingOfferCheckoutKind,
} from './billingOfferCheckoutKind.js';

export type BillingOfferCycle = 'monthly' | 'annual';
export type BillingOfferType = 'subscription' | 'payment_link';
export type { BillingOfferCheckoutKind };

export type CreateBillingOfferInput = {
  planId: string;
  billingCycle: BillingOfferCycle;
  currency: BillingCurrency;
  /** Override catalog price in paise/cents. */
  amountMinor?: number | null;
  note?: string | null;
  createdByPlatformAdminId?: string | null;
  /** Default subscription. payment_link skips Razorpay Subscriptions. */
  checkoutKind?: BillingOfferCheckoutKind;
  /**
   * When checkoutKind is subscription and create fails, create a one-time
   * payment link instead (surfaced via fallbackReason). Off by default — no silent USD fallback.
   */
  allowPaymentLinkFallback?: boolean;
};

function mapOffer(
  offer: {
    id: string;
    workspaceId: string;
    planId: string;
    billingCycle: string;
    currency: string;
    amountMinor: number;
    offerType: string;
    status: string;
    razorpayPlanId: string | null;
    razorpaySubscriptionId: string | null;
    razorpayPaymentLinkId: string | null;
    shortUrl: string | null;
    note: string | null;
    createdByPlatformAdminId: string | null;
    paidAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    plan?: { id: string; slug: string; name: string };
  },
  extras?: { fallbackReason?: string | null }
) {
  return {
    id: offer.id,
    workspaceId: offer.workspaceId,
    planId: offer.planId,
    plan: offer.plan
      ? { id: offer.plan.id, slug: offer.plan.slug, name: offer.plan.name }
      : undefined,
    billingCycle: offer.billingCycle as BillingOfferCycle,
    currency: offer.currency as BillingCurrency,
    amountMinor: offer.amountMinor,
    offerType: offer.offerType as BillingOfferType,
    status: offer.status as 'pending' | 'paid' | 'cancelled',
    razorpayPlanId: offer.razorpayPlanId,
    razorpaySubscriptionId: offer.razorpaySubscriptionId,
    razorpayPaymentLinkId: offer.razorpayPaymentLinkId,
    shortUrl: offer.shortUrl,
    note: offer.note,
    createdByPlatformAdminId: offer.createdByPlatformAdminId,
    paidAt: offer.paidAt?.toISOString() ?? null,
    cancelledAt: offer.cancelledAt?.toISOString() ?? null,
    createdAt: offer.createdAt.toISOString(),
    updatedAt: offer.updatedAt.toISOString(),
    keyId: config.razorpay.keyId || null,
    ...(extras?.fallbackReason
      ? { fallbackReason: extras.fallbackReason }
      : {}),
  };
}

async function cancelPendingOffers(workspaceId: string) {
  await prisma.billingOffer.updateMany({
    where: { workspaceId, status: 'pending' },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}

/** What to cancel on Razorpay before cancel/delete. Paid offers leave remotes alone. */
export function razorpayCancelTargets(offer: {
  status: string;
  razorpaySubscriptionId: string | null;
  razorpayPaymentLinkId: string | null;
}): { subscriptionId?: string; paymentLinkId?: string } {
  if (offer.status === 'paid') return {};
  return {
    ...(offer.razorpaySubscriptionId
      ? { subscriptionId: offer.razorpaySubscriptionId }
      : {}),
    ...(offer.razorpayPaymentLinkId
      ? { paymentLinkId: offer.razorpayPaymentLinkId }
      : {}),
  };
}

async function cancelOfferOnRazorpay(
  fastify: FastifyInstance,
  offer: {
    status: string;
    razorpaySubscriptionId: string | null;
    razorpayPaymentLinkId: string | null;
  }
) {
  const targets = razorpayCancelTargets(offer);
  if (!targets.subscriptionId && !targets.paymentLinkId) return;
  if (!config.razorpay.enabled) return;

  const razorpay = new RazorpayService(fastify);
  if (targets.subscriptionId) {
    try {
      await razorpay.cancelSubscription(targets.subscriptionId, false);
    } catch (err) {
      console.warn('[billingOffers] razorpay subscription cancel failed', {
        subscriptionId: targets.subscriptionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // Local BillingSubscription created with the offer — mark cancelled if still unpaid.
    await prisma.billingSubscription.updateMany({
      where: {
        razorpaySubscriptionId: targets.subscriptionId,
        status: { notIn: ['active', 'cancelled'] },
      },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
  }
  if (targets.paymentLinkId) {
    try {
      await razorpay.cancelPaymentLink(targets.paymentLinkId);
    } catch (err) {
      console.warn('[billingOffers] razorpay payment link cancel failed', {
        paymentLinkId: targets.paymentLinkId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function listBillingOffersForWorkspace(
  workspaceId: string,
  options?: { status?: 'pending' | 'paid' | 'cancelled' | 'all' }
) {
  const status = options?.status ?? 'all';
  const offers = await prisma.billingOffer.findMany({
    where: {
      workspaceId,
      ...(status === 'all' ? {} : { status }),
    },
    include: { plan: { select: { id: true, slug: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return offers.map((offer) => mapOffer(offer));
}

export async function listPendingBillingOffers(workspaceId: string) {
  return listBillingOffersForWorkspace(workspaceId, { status: 'pending' });
}

export async function cancelBillingOffer(
  fastify: FastifyInstance,
  workspaceId: string,
  offerId: string
) {
  const offer = await prisma.billingOffer.findFirst({
    where: { id: offerId, workspaceId },
  });
  if (!offer) throw new Error('Billing offer not found');
  if (offer.status !== 'pending') throw new Error(`Offer is already ${offer.status}`);

  await cancelOfferOnRazorpay(fastify, offer);

  const updated = await prisma.billingOffer.update({
    where: { id: offer.id },
    data: { status: 'cancelled', cancelledAt: new Date() },
    include: { plan: { select: { id: true, slug: true, name: true } } },
  });
  return mapOffer(updated);
}

/** Hard-delete offer after best-effort Razorpay cancel (if still open). */
export async function deleteBillingOffer(
  fastify: FastifyInstance,
  workspaceId: string,
  offerId: string
) {
  const offer = await prisma.billingOffer.findFirst({
    where: { id: offerId, workspaceId },
    include: { plan: { select: { id: true, slug: true, name: true } } },
  });
  if (!offer) throw new Error('Billing offer not found');

  await cancelOfferOnRazorpay(fastify, offer);
  await prisma.billingOffer.delete({ where: { id: offer.id } });
  return mapOffer(offer);
}

export async function createBillingOffer(
  fastify: FastifyInstance,
  workspaceId: string,
  input: CreateBillingOfferInput
) {
  if (!config.razorpay.enabled) {
    throw new Error('Razorpay is not configured');
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true },
  });
  if (!workspace) throw new Error('Organization not found');

  const plan = await prisma.subscriptionPlan.findFirst({
    where: {
      OR: [{ id: input.planId }, { slug: input.planId }],
      isActive: true,
    },
  });
  if (!plan) throw new Error('Plan not found');

  const currency = input.currency;
  const billingCycle = input.billingCycle;
  const catalogAmount = planAmountMinor(plan, billingCycle, currency);
  const amountMinor =
    input.amountMinor != null && input.amountMinor > 0
      ? Math.round(input.amountMinor)
      : catalogAmount;
  if (amountMinor == null || amountMinor < minCheckoutMinor(currency)) {
    throw new Error(
      `Invalid amount for ${currency}. Minimum is ${minCheckoutMinor(currency)} minor units.`
    );
  }

  const isCustomAmount = catalogAmount == null || amountMinor !== catalogAmount;
  const razorpay = new RazorpayService(fastify);

  let razorpayPlanId: string | null = isCustomAmount
    ? null
    : resolveCheckoutRazorpayPlanId(plan, billingCycle, currency);

  if (isCustomAmount || !razorpayPlanId) {
    const period = billingCycle === 'annual' ? 'yearly' : 'monthly';
    const createdPlan = await razorpay.createPlan({
      name: `${plan.name} (${billingCycle}, ${currency})${isCustomAmount ? ' custom' : ''}`,
      amountPaise: amountMinor,
      currency,
      period,
      description: `Billing offer for ${workspace.name}`,
      notes: {
        workspaceId,
        planId: plan.id,
        purpose: 'billing_offer',
      },
    });
    razorpayPlanId = createdPlan.id;
  }

  await cancelPendingOffers(workspaceId);

  const checkoutKind: BillingOfferCheckoutKind = input.checkoutKind ?? 'subscription';
  const allowPaymentLinkFallback = Boolean(input.allowPaymentLinkFallback);
  let offerType: BillingOfferType = 'payment_link';
  let razorpaySubscriptionId: string | null = null;
  let razorpayPaymentLinkId: string | null = null;
  let shortUrl: string | null = null;
  let fallbackReason: string | null = null;

  // Admin billing offers always try Subscriptions when asked — do not gate on
  // recurringEnabled / catalog env plan IDs (we create a Razorpay plan above).
  if (checkoutKind === 'subscription') {
    if (!razorpayPlanId) {
      throw new Error('Razorpay plan id missing; cannot create subscription offer');
    }
    try {
      const customerId = await ensureRazorpayCustomer(workspaceId, razorpay);
      const totalCount = billingCycle === 'annual' ? 10 : 120;
      // ponytail: do not pass customer_id — Razorpay create returns opaque Validation failed.
      // start_at is set inside RazorpayService.createSubscription (required on this account).
      const rzSub = (await razorpay.createSubscription({
        planId: razorpayPlanId,
        totalCount,
        customerNotify: true,
        notes: {
          workspaceId,
          planId: plan.id,
          billingCycle,
          currency,
          purpose: 'billing_offer',
        },
      })) as { id: string; status: string; short_url?: string };

      await prisma.billingSubscription.create({
        data: {
          workspaceId,
          planId: plan.id,
          razorpaySubscriptionId: rzSub.id,
          razorpayCustomerId: customerId,
          razorpayPlanId,
          status: rzSub.status,
          billingCycle,
        },
      });

      offerType = 'subscription';
      razorpaySubscriptionId = rzSub.id;
      shortUrl = rzSub.short_url ?? null;
    } catch (err) {
      const details = extractRazorpayErrorDetails(err);
      const normalized = normalizeRazorpayError(err);
      console.warn('[billingOffers] subscription create failed', {
        workspaceId,
        currency,
        razorpayPlanId,
        message: details.message,
        statusCode: details.statusCode,
        code: details.code,
        description: details.description,
        field: details.field,
        reason: details.reason,
        source: details.source,
        step: details.step,
        metadata: details.metadata,
        rawError: details.rawError,
        allowPaymentLinkFallback,
      });
      const decided = resolveOfferCheckoutKind({
        checkoutKind: 'subscription',
        allowPaymentLinkFallback,
        subscriptionFailed: true,
        subscriptionErrorMessage: normalized.message,
      });
      fallbackReason = decided.fallbackReason ?? null;
      offerType = 'payment_link';
    }
  }

  if (offerType === 'payment_link') {
    const contact = await getWorkspaceRazorpayContact(workspaceId);
    if (!contact.email && !contact.phone) {
      throw new Error(
        'Workspace needs an email or phone for payment links. Set it on the organization first.'
      );
    }
    const expireBy = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const noteBase = input.note?.trim() || null;
    const noteWithFallback =
      fallbackReason && noteBase
        ? `${noteBase}\n[payment_link fallback] ${fallbackReason}`
        : fallbackReason
          ? `[payment_link fallback] ${fallbackReason}`
          : noteBase;

    // Create offer row first so notes can include billingOfferId — two-step below.
    const pending = await prisma.billingOffer.create({
      data: {
        workspaceId,
        planId: plan.id,
        billingCycle,
        currency,
        amountMinor,
        offerType: 'payment_link',
        status: 'pending',
        razorpayPlanId,
        note: noteWithFallback,
        createdByPlatformAdminId: input.createdByPlatformAdminId ?? null,
      },
    });

    try {
      const link = await razorpay.createPaymentLink({
        amountPaise: amountMinor,
        currency,
        description: `${plan.name} plan (${billingCycle})`,
        customerName: contact.name,
        customerPhone: contact.phone,
        customerEmail: contact.email,
        expireBy,
        notes: {
          workspaceId,
          planId: plan.id,
          billingCycle,
          currency,
          purpose: 'billing_offer',
          billingOfferId: pending.id,
        },
      });

      const updated = await prisma.billingOffer.update({
        where: { id: pending.id },
        data: {
          razorpayPaymentLinkId: link.id,
          shortUrl: link.short_url,
        },
        include: { plan: { select: { id: true, slug: true, name: true } } },
      });
      return mapOffer(updated, { fallbackReason });
    } catch (err) {
      await prisma.billingOffer.update({
        where: { id: pending.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      throw err;
    }
  }

  const offer = await prisma.billingOffer.create({
    data: {
      workspaceId,
      planId: plan.id,
      billingCycle,
      currency,
      amountMinor,
      offerType,
      status: 'pending',
      razorpayPlanId,
      razorpaySubscriptionId,
      razorpayPaymentLinkId,
      shortUrl,
      note: input.note?.trim() || null,
      createdByPlatformAdminId: input.createdByPlatformAdminId ?? null,
    },
    include: { plan: { select: { id: true, slug: true, name: true } } },
  });

  return mapOffer(offer);
}

/** Mark offer paid (idempotent) and assign the plan to the workspace. */
export async function fulfillBillingOfferPaid(params: {
  offerId?: string | null;
  razorpayPaymentLinkId?: string | null;
  razorpaySubscriptionId?: string | null;
  razorpayPaymentId?: string | null;
  /** For logs — which webhook / verify path activated the plan. */
  activatedBy?: string;
}) {
  const or = [
    ...(params.offerId ? [{ id: params.offerId }] : []),
    ...(params.razorpayPaymentLinkId
      ? [{ razorpayPaymentLinkId: params.razorpayPaymentLinkId }]
      : []),
    ...(params.razorpaySubscriptionId
      ? [{ razorpaySubscriptionId: params.razorpaySubscriptionId }]
      : []),
  ];
  if (or.length === 0) return null;

  const offer = await prisma.billingOffer.findFirst({
    where: { status: 'pending', OR: or },
    include: { plan: true },
  });
  if (!offer) return null;

  const activatedBy = params.activatedBy ?? 'fulfillBillingOfferPaid';
  const billingCycle = (offer.billingCycle === 'annual' ? 'annual' : 'monthly') as BillingOfferCycle;

  if (offer.offerType === 'payment_link') {
    const periodEnd = new Date();
    if (billingCycle === 'annual') periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    else periodEnd.setMonth(periodEnd.getMonth() + 1);

    await prisma.$transaction(async (tx) => {
      await tx.billingOffer.update({
        where: { id: offer.id },
        data: { status: 'paid', paidAt: new Date() },
      });

      await tx.billingSubscription.create({
        data: {
          workspaceId: offer.workspaceId,
          planId: offer.planId,
          status: 'active',
          billingCycle,
          currentPeriodStart: new Date(),
          currentPeriodEnd: periodEnd,
        },
      });

      await tx.billingInvoice.create({
        data: {
          workspaceId: offer.workspaceId,
          razorpayPaymentId: params.razorpayPaymentId ?? undefined,
          type: 'plan_purchase',
          amountPaise: offer.amountMinor,
          currency: offer.currency,
          status: 'paid',
          paidAt: new Date(),
          description: `${offer.plan.name} plan (${billingCycle}) · billing offer`,
          metadata: {
            planId: offer.planId,
            billingCycle,
            billingOfferId: offer.id,
            purpose: 'billing_offer',
          },
        },
      });

      await tx.workspace.update({
        where: { id: offer.workspaceId },
        data: {
          planId: offer.planId,
          ...paidActivationWorkspaceFields(),
        },
      });

      await syncWorkspaceLimitsFromPlanFeatures(
        offer.workspaceId,
        offer.plan.features as PlanFeatures,
        tx
      );
    });
  } else {
    // Subscription offer: BillingSubscription row already exists from createBillingOffer.
    await prisma.$transaction(async (tx) => {
      await tx.billingOffer.update({
        where: { id: offer.id },
        data: { status: 'paid', paidAt: new Date() },
      });

      if (offer.razorpaySubscriptionId) {
        await tx.billingSubscription.updateMany({
          where: {
            razorpaySubscriptionId: offer.razorpaySubscriptionId,
            status: { in: ['created', 'pending'] },
          },
          data: { status: 'authenticated' },
        });
      }

      await tx.workspace.update({
        where: { id: offer.workspaceId },
        data: {
          planId: offer.planId,
          ...paidActivationWorkspaceFields(),
        },
      });

      await syncWorkspaceLimitsFromPlanFeatures(
        offer.workspaceId,
        offer.plan.features as PlanFeatures,
        tx
      );
    });
  }

  console.log('[billingOffers] workspace plan activated', {
    activatedBy,
    offerId: offer.id,
    offerType: offer.offerType,
    workspaceId: offer.workspaceId,
    planId: offer.planId,
    planName: offer.plan.name,
    razorpaySubscriptionId: offer.razorpaySubscriptionId,
    razorpayPaymentId: params.razorpayPaymentId ?? null,
  });

  void import('./notifications/paymentNotify.js').then(({ notifyPaymentOutcome }) =>
    notifyPaymentOutcome({
      workspaceId: offer.workspaceId,
      success: true,
      label: offer.plan.name,
      amountPaise: offer.amountMinor,
      currency: offer.currency,
      entityType: 'billing_offer',
      entityId: offer.id,
      metadata: {
        billingOfferId: offer.id,
        purpose: 'billing_offer',
        activatedBy,
        razorpayPaymentId: params.razorpayPaymentId ?? null,
        razorpaySubscriptionId: offer.razorpaySubscriptionId,
      },
    })
  );

  return offer.id;
}

export async function markBillingOfferPaidBySubscription(
  razorpaySubscriptionId: string,
  activatedBy = 'subscription'
) {
  return fulfillBillingOfferPaid({ razorpaySubscriptionId, activatedBy });
}
