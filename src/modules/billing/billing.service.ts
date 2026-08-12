import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import {
  verifyRazorpayPaymentSignature,
  verifyRazorpaySubscriptionSignature,
} from '../../utils/crypto.utils.js';
import { readCustomPlanInput } from '../../services/customPlanPricing.js';
import {
  seedSubscriptionPlans,
  campaignsLimitFromFeatures,
  syncWorkspaceLimitsFromPlanFeatures,
  type PlanFeatures,
} from '../../services/subscriptionPlans.js';
import { resolveCheckoutRazorpayPlanId } from '../../services/razorpayPlanSync.js';
import { isUnlimitedUsageLimit, UNLIMITED_USAGE_LIMIT } from '../../services/usageLimits.js';
import {
  computeTokenBillingCosts,
  getWorkspaceMonthlyTokenUsage,
} from '../../services/workspaceTokenUsage.js';
import { applyAiUsageMarkup } from '../../services/usageCost.constants.js';
import type {
  AddOnType,
  BillingCycle,
  CreateOrderBody,
  CreateSubscriptionBody,
  OrderPurpose,
} from './billing.types.js';
import { ADDON_CATALOG } from './billing.types.js';
import {
  creditPlanWalletCredits,
  creditWallet,
  getWalletSummary,
  updateWalletSettings,
} from '../../services/wallet.service.js';
import {
  ensureRazorpayCustomer,
  extractPaymentCredentials,
  persistWalletPaymentMethod,
  saveWalletPaymentCredentials,
} from '../../services/razorpayCustomer.service.js';
import {
  creditCouponBonusWalletCredits,
  recordCouponRedemption,
  MIN_CHECKOUT_AMOUNT_PAISE,
  validateDiscountCoupon,
} from '../../services/discountCoupons.js';
import { paidActivationWorkspaceFields } from '../../services/trial.js';
import {
  countryToCurrency,
  minCheckoutMinor,
  minWalletTopupMinor,
  planAmountMinor,
  toMinorUnits,
  type BillingCurrency,
} from '../../services/billingCurrency.js';
import {
  matchSubscriptionIdByCheckoutDescription,
  subscriptionCheckoutPaymentOk,
} from '../../services/subscriptionPaymentOk.js';
import type { RazorpayService } from './razorpay.service.js';
import {
  webhookPaymentEntity,
  type RazorpayWebhookPayload,
} from './razorpay-webhook.types.js';

const USD_INR_FALLBACK = 83;
const FX_CACHE_TTL_MS = 30 * 60 * 1000;
let usdInrCache: { rate: number; fetchedAtMs: number; source: string } | null = null;

/** Double-click / retry window for server-generated idempotency keys. */
const IDEMPOTENCY_WINDOW_MS = 120_000;

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

function buildServerIdempotencyKey(workspaceId: string, purposeKey: string): string {
  const bucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
  return `${workspaceId}:${purposeKey}:${bucket}`;
}

function webhookEntity(
  payload: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const wrapper = payload[key];
  if (!wrapper || typeof wrapper !== 'object') return undefined;
  const entity = (wrapper as Record<string, unknown>).entity;
  if (!entity || typeof entity !== 'object') return undefined;
  return entity as Record<string, unknown>;
}

const SETTLED_PAYMENT_STATUSES = ['paid', 'failed'] as const;
/** Subscriptions the product treats as an active paid plan (excludes abandoned `created` rows). */
const LIVE_BILLING_SUB_STATUSES = ['active', 'authenticated', 'paused'] as const;

function walletTopupCreditPaise(invoice: {
  amountPaise: number;
  metadata: Prisma.JsonValue | null;
}): number {
  const meta = invoice.metadata as { creditAmountPaise?: number } | null;
  if (meta?.creditAmountPaise && meta.creditAmountPaise > 0) {
    return meta.creditAmountPaise;
  }
  return invoice.amountPaise;
}

export class BillingService {
  constructor(private readonly razorpay: RazorpayService) {}

  private async workspaceCurrency(workspaceId: string): Promise<BillingCurrency> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { country: true },
    });
    return countryToCurrency(workspace?.country);
  }

  async listPlans() {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    return plans
      .filter((plan) => !plan.slug.startsWith('custom-'))
      .map((plan) => ({
        id: plan.id,
        slug: plan.slug,
        name: plan.name,
        priceMonthlyPaise: plan.priceMonthlyPaise,
        priceAnnualPaise: plan.priceAnnualPaise,
        priceMonthlyUsd: plan.priceMonthlyUsd,
        priceAnnualUsd: plan.priceAnnualUsd,
        priceMonthlyCents: plan.priceMonthlyCents,
        priceAnnualCents: plan.priceAnnualCents,
        razorpayPlanIdMonthly: plan.razorpayPlanIdMonthly,
        razorpayPlanIdAnnual: plan.razorpayPlanIdAnnual,
        razorpayPlanIdMonthlyUsd: plan.razorpayPlanIdMonthlyUsd,
        razorpayPlanIdAnnualUsd: plan.razorpayPlanIdAnnualUsd,
        features: plan.features,
      }));
  }

  async getWorkspaceBilling(workspaceId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        plan: true,
        usageLimits: true,
      },
    });

    if (!workspace) throw new Error('Workspace not found');

    const activeSub = await prisma.billingSubscription.findFirst({
      where: {
        workspaceId,
        status: { in: [...LIVE_BILLING_SUB_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    const paidPlan = activeSub?.plan ?? null;
    const settledStatusFilter = { in: [...SETTLED_PAYMENT_STATUSES] };
    const [{ rate: usdInrRate, fetchedAtMs: fxFetchedAtMs, source: fxSource }, recentInvoices, recentAddons] =
      await Promise.all([
        this.getUsdInrRate(),
      prisma.billingInvoice.findMany({
        where: { workspaceId, status: settledStatusFilter },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.billingAddOnPurchase.findMany({
        where: { workspaceId, status: settledStatusFilter },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      ]);

    const planForLimits = paidPlan ?? workspace.plan;
    const planFeatures = planForLimits?.features as PlanFeatures | undefined;
    const limitsForSnapshot =
      workspace.usageLimits && planFeatures
        ? {
            ...workspace.usageLimits,
            campaignsLimit: campaignsLimitFromFeatures(planFeatures),
          }
        : workspace.usageLimits;

    const [usageSnapshot, connectedChannels, wallet] = await Promise.all([
      this.getUsageSnapshot(workspaceId, limitsForSnapshot),
      this.getConnectedChannels(workspaceId),
      getWalletSummary(workspaceId),
    ]);

    return {
      workspaceId,
      subscriptionStatus: workspace.subscriptionStatus,
      country: workspace.country ?? 'IN',
      currency: countryToCurrency(workspace.country),
      wallet,
      plan: paidPlan
        ? {
            id: paidPlan.id,
            slug: paidPlan.slug,
            name: paidPlan.name,
          }
        : null,
      billingSubscription: activeSub
        ? {
            id: activeSub.id,
            status: activeSub.status,
            billingCycle: activeSub.billingCycle,
            razorpaySubscriptionId: activeSub.razorpaySubscriptionId,
            currentPeriodStart: activeSub.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: activeSub.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: activeSub.cancelAtPeriodEnd,
            plan: activeSub.plan
              ? { id: activeSub.plan.id, slug: activeSub.plan.slug, name: activeSub.plan.name }
              : null,
          }
        : null,
      usageLimits: workspace.usageLimits,
      usageSnapshot,
      connectedChannels,
      addonCatalog: ADDON_CATALOG.map((entry) => ({
        ...entry,
        unitPaise:
          countryToCurrency(workspace.country) === 'USD'
            ? toMinorUnits(entry.usdPerUnit)
            : this.usdToInrPaise(entry.usdPerUnit, usdInrRate),
      })),
      fx: {
        usdInrRate,
        fetchedAt: new Date(fxFetchedAtMs).toISOString(),
        source: fxSource,
      },
      emailProvider: {
        name: 'resend',
        pricingLabel: '$1 per 1,000 emails',
      },
      recentInvoices: recentInvoices.map((inv) => this.serializeInvoice(inv)),
      recentAddons: recentAddons.map((addon) => this.serializeAddon(addon)),
      razorpayKeyId: config.razorpay.keyId || null,
    };
  }

  private async getUsageSnapshot(
    workspaceId: string,
    limits: {
      contactsLimit: number;
      teamMembersLimit: number;
      aiAgentsLimit: number;
      channelsLimit: number;
      campaignsLimit: number;
      emailsLimit: number;
      aiTokensIncluded: number;
    } | null
  ) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);

    const [
      contactsUsed,
      teamMembersUsed,
      aiAgentsUsed,
      campaignsUsed,
      emailsUsed,
      workspaceChannelFlags,
      whatsappChannels,
      instagramChannels,
      messengerChannels,
      aiTokenUsage,
    ] = await Promise.all([
      prisma.contact.count({ where: { workspaceId } }),
      prisma.workspaceMembership.count({ where: { workspaceId } }),
      prisma.aiAgent.count({ where: { workspaceId } }),
      prisma.campaign.count({ where: { workspaceId } }),
      prisma.emailLog.count({
        where: {
          workspaceId,
          status: 'sent',
          createdAt: { gte: monthStart, lt: monthEnd },
        },
      }),
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { emailIntegrationEnabled: true, waNumberId: true },
      }),
      prisma.whatsAppPhoneAccount.count({ where: { workspaceId } }),
      prisma.instagramAccount.count({ where: { workspaceId } }),
      prisma.messengerAccount.count({ where: { workspaceId } }),
      getWorkspaceMonthlyTokenUsage(workspaceId),
    ]);

    const channelsUsed =
      Math.max(whatsappChannels, workspaceChannelFlags?.waNumberId ? 1 : 0) +
      instagramChannels +
      messengerChannels +
      (workspaceChannelFlags?.emailIntegrationEnabled ? 1 : 0);

    const limitValue = (value: number | null | undefined, fallback: number) =>
      value == null ? fallback : value;
    const toSnapshotItem = (used: number, limit: number) => {
      if (isUnlimitedUsageLimit(limit)) {
        return { used, limit: UNLIMITED_USAGE_LIMIT, pending: UNLIMITED_USAGE_LIMIT };
      }
      return { used, limit, pending: Math.max(0, limit - used) };
    };

    const aiTokenLimit = limitValue(limits?.aiTokensIncluded, 0);
    const markedUpTokenCostInr = applyAiUsageMarkup(aiTokenUsage.costInr);
    const tokenCosts = computeTokenBillingCosts({
      costInr: markedUpTokenCostInr,
      includedTokens: aiTokenLimit,
    });
    // Limit is wallet-token credit; track marked-up charge against it (not raw LLM tokens)
    const aiCreditUsed = Math.round(markedUpTokenCostInr * 100) / 100;
    const aiTokensSnapshot =
      aiTokenLimit <= 0
        ? {
            used: aiCreditUsed,
            limit: UNLIMITED_USAGE_LIMIT,
            pending: UNLIMITED_USAGE_LIMIT,
            inputTokens: aiTokenUsage.inputTokens,
            outputTokens: aiTokenUsage.outputTokens,
            costInr: markedUpTokenCostInr,
            includedCreditInr: tokenCosts.includedCreditInr,
            billedCostInr: tokenCosts.billedCostInr,
          }
        : {
            ...toSnapshotItem(aiCreditUsed, aiTokenLimit),
            inputTokens: aiTokenUsage.inputTokens,
            outputTokens: aiTokenUsage.outputTokens,
            costInr: markedUpTokenCostInr,
            includedCreditInr: tokenCosts.includedCreditInr,
            billedCostInr: tokenCosts.billedCostInr,
          };

    return {
      contacts: toSnapshotItem(contactsUsed, limitValue(limits?.contactsLimit, 1000)),
      teamMembers: toSnapshotItem(teamMembersUsed, limitValue(limits?.teamMembersLimit, 3)),
      aiAgents: toSnapshotItem(aiAgentsUsed, limitValue(limits?.aiAgentsLimit, 1)),
      // Report actual channel cap from workspace usage limits
      channels: toSnapshotItem(channelsUsed, limitValue(limits?.channelsLimit, 1)),
      campaigns: toSnapshotItem(
        campaignsUsed,
        limitValue(limits?.campaignsLimit, UNLIMITED_USAGE_LIMIT)
      ),
      // emailsLimit 0 = wallet CC metering (no plan quota) — don't show exhausted "0 left"
      emails: (() => {
        const emailCap = limitValue(limits?.emailsLimit, 0);
        if (emailCap <= 0) {
          return { used: emailsUsed, limit: UNLIMITED_USAGE_LIMIT, pending: UNLIMITED_USAGE_LIMIT };
        }
        return toSnapshotItem(emailsUsed, emailCap);
      })(),
      aiTokens: aiTokensSnapshot,
    };
  }

  private async getConnectedChannels(workspaceId: string) {
    const [whatsappAccounts, instagramAccounts, messengerAccounts, workspace] = await Promise.all([
      prisma.whatsAppPhoneAccount.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          phoneNumber: true,
          displayName: true,
          phoneNumberId: true,
          createdAt: true,
        },
      }),
      prisma.instagramAccount.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          username: true,
          displayName: true,
          pageName: true,
          profilePicture: true,
          createdAt: true,
        },
      }),
      prisma.messengerAccount.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          pageName: true,
          displayName: true,
          profilePicture: true,
          createdAt: true,
        },
      }),
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { emailIntegrationEnabled: true, updatedAt: true },
      }),
    ]);

    type ConnectedChannel = {
      id: string;
      type: 'whatsapp' | 'instagram' | 'messenger' | 'email';
      label: string;
      subtitle?: string;
      avatarUrl?: string;
      connectedAt: string;
    };

    const channels: ConnectedChannel[] = [];

    for (const account of whatsappAccounts) {
      channels.push({
        id: account.id,
        type: 'whatsapp',
        label: account.displayName || 'WhatsApp Business',
        subtitle: account.phoneNumber || account.phoneNumberId,
        connectedAt: account.createdAt.toISOString(),
      });
    }

    for (const account of instagramAccounts) {
      channels.push({
        id: account.id,
        type: 'instagram',
        label: account.username ? `@${account.username}` : account.displayName || 'Instagram',
        subtitle: account.pageName ? `Page · ${account.pageName}` : undefined,
        avatarUrl: account.profilePicture ?? undefined,
        connectedAt: account.createdAt.toISOString(),
      });
    }

    for (const account of messengerAccounts) {
      channels.push({
        id: account.id,
        type: 'messenger',
        label: account.displayName || account.pageName || 'Messenger',
        subtitle: account.pageName ? `Page · ${account.pageName}` : undefined,
        avatarUrl: account.profilePicture ?? undefined,
        connectedAt: account.createdAt.toISOString(),
      });
    }

    if (workspace?.emailIntegrationEnabled) {
      channels.push({
        id: 'email',
        type: 'email',
        label: 'Email',
        subtitle: 'Outbound email enabled',
        connectedAt: workspace.updatedAt.toISOString(),
      });
    }

    return channels;
  }

  async listBillingTransactions(workspaceId: string, limit = 50) {
    const settledStatusFilter = { in: [...SETTLED_PAYMENT_STATUSES] };
    const [invoices, addons] = await Promise.all([
      prisma.billingInvoice.findMany({
        where: { workspaceId, status: settledStatusFilter },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.billingAddOnPurchase.findMany({
        where: { workspaceId, status: settledStatusFilter },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const rows = [
      ...invoices.map((inv) => ({
        ...this.serializeInvoice(inv),
        source: 'invoice' as const,
      })),
      ...addons.map((addon) => ({
        ...this.serializeAddon(addon),
        source: 'addon' as const,
      })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return rows.slice(0, limit);
  }

  private serializeInvoice(inv: {
    id: string;
    type: string;
    amountPaise: number;
    currency: string;
    status: string;
    description: string | null;
    razorpayOrderId: string | null;
    razorpayPaymentId: string | null;
    razorpayInvoiceId: string | null;
    paidAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: inv.id,
      type: inv.type,
      amountPaise: inv.amountPaise,
      currency: inv.currency,
      status: inv.status,
      description: inv.description,
      razorpayOrderId: inv.razorpayOrderId,
      razorpayPaymentId: inv.razorpayPaymentId,
      razorpayInvoiceId: inv.razorpayInvoiceId,
      paidAt: inv.paidAt?.toISOString() ?? null,
      createdAt: inv.createdAt.toISOString(),
    };
  }

  private serializeAddon(addon: {
    id: string;
    type: string;
    quantity: number;
    amountPaise: number;
    currency: string;
    status: string;
    razorpayOrderId: string | null;
    razorpayPaymentId: string | null;
    validUntil: Date | null;
    createdAt: Date;
  }) {
    return {
      id: addon.id,
      type: `addon_${addon.type}`,
      amountPaise: addon.amountPaise,
      currency: addon.currency,
      status: addon.status,
      description: `Add-on · ${addon.type.replace(/_/g, ' ')} × ${addon.quantity}`,
      razorpayOrderId: addon.razorpayOrderId,
      razorpayPaymentId: addon.razorpayPaymentId,
      razorpayInvoiceId: null as string | null,
      quantity: addon.quantity,
      validUntil: addon.validUntil?.toISOString() ?? null,
      paidAt: addon.status === 'paid' ? addon.createdAt.toISOString() : null,
      createdAt: addon.createdAt.toISOString(),
    };
  }

  async createOrder(workspaceId: string, body: CreateOrderBody) {
    const { amountPaise, purpose, addonType, quantity, description, creditAmountPaise } = body;
    const currency = await this.workspaceCurrency(workspaceId);

    let finalAmount = amountPaise ?? 0;
    let invoiceType: OrderPurpose = purpose ?? 'one_time';
    let addonRecord: { type: AddOnType; quantity: number } | null = null;
    let walletTopupMeta: Prisma.InputJsonValue | undefined;

    if (purpose === 'custom_plan' || (!purpose && !addonType && !amountPaise)) {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      const selection = workspace?.customPlanSelection as {
        monthlyTotal?: number;
        currency?: string;
      } | null;
      const monthly = selection?.monthlyTotal;
      if (monthly && monthly > 0) {
        // Custom plan totals are authored in USD; charge USD cents abroad, INR via FX in India.
        if (currency === 'USD') {
          finalAmount = toMinorUnits(monthly);
        } else {
          const { rate } = await this.getUsdInrRate();
          finalAmount = this.usdToInrPaise(monthly, rate);
        }
        invoiceType = 'custom_plan';
      }
    }

    if (addonType) {
      finalAmount = await this.addonAmountMinor(addonType, quantity ?? 1, currency);
      invoiceType = 'addon';
      addonRecord = { type: addonType, quantity: quantity ?? 1 };
    }

    if (purpose === 'wallet_topup') {
      const minTopup = minWalletTopupMinor(currency);
      if (!amountPaise || amountPaise < minTopup) {
        throw new Error(
          currency === 'USD' ? 'Minimum wallet top-up is $2.' : 'Minimum wallet top-up is ₹100.'
        );
      }
      finalAmount = amountPaise;
      invoiceType = 'wallet_topup';
      // creditAmountPaise is always ConvoCoin minor units (1 CC = ₹1), not charge currency.
      const creditPaise = creditAmountPaise ?? (currency === 'INR' ? amountPaise : undefined);
      if (!creditPaise || creditPaise <= 0) {
        throw new Error('Wallet top-up requires creditAmountPaise (ConvoCoin units).');
      }
      walletTopupMeta = {
        purpose: 'wallet_topup',
        creditAmountPaise: creditPaise,
        chargeCurrency: currency,
      };
    }

    const minCheckout = minCheckoutMinor(currency);
    if (!finalAmount || finalAmount < minCheckout) {
      throw new Error(
        currency === 'USD'
          ? `Invalid order amount. Minimum is $${(minCheckout / 100).toFixed(2)}.`
          : `Invalid order amount. Minimum is ${MIN_CHECKOUT_AMOUNT_PAISE} paise (₹1).`
      );
    }

    const purposeKey = [
      invoiceType,
      currency,
      addonType ?? '',
      String(quantity ?? ''),
      String(finalAmount),
      String(creditAmountPaise ?? ''),
    ].join(':');
    const idempotencyKey =
      body.idempotencyKey?.trim() || buildServerIdempotencyKey(workspaceId, purposeKey);

    const existingCheckout = await this.checkoutFromExistingIntent(idempotencyKey);
    if (existingCheckout) return existingCheckout;

    let intent;
    try {
      intent = await prisma.paymentIntent.create({
        data: {
          idempotencyKey,
          workspaceId,
          amount: finalAmount,
          currency,
          status: 'pending',
        },
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        const raced = await this.checkoutFromExistingIntent(idempotencyKey);
        if (raced) return raced;
        console.error('[billing.createOrder] P2002 without usable PaymentIntent', {
          workspaceId,
          idempotencyKey,
        });
        throw new Error('Payment order is already being created. Please retry shortly.');
      }
      throw err;
    }

    let order: { id: string };
    try {
      const receipt = `convosync_${workspaceId.slice(-8)}_${Date.now()}`;
      order = await this.razorpay.createOrder({
        amountPaise: finalAmount,
        currency,
        receipt,
        notes: {
          workspaceId,
          purpose: invoiceType,
          currency,
          ...(addonType ? { addonType, quantity: String(quantity ?? 1) } : {}),
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[billing.createOrder] Razorpay createOrder failed', {
        workspaceId,
        idempotencyKey,
        err,
      });
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'failed', failureReason: reason.slice(0, 500) },
      });
      throw err;
    }

    try {
      const invoice = await prisma.$transaction(async (tx) => {
        const created = await tx.billingInvoice.create({
          data: {
            workspaceId,
            razorpayOrderId: order.id,
            type: invoiceType,
            amountPaise: finalAmount,
            currency,
            status: 'created',
            description: description ?? `${invoiceType} payment`,
            metadata: (walletTopupMeta ??
              ({ purpose: invoiceType, addonType, quantity } as Prisma.InputJsonValue)),
          },
        });

        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: {
            razorpayOrderId: order.id,
            billingInvoiceId: created.id,
          },
        });

        if (addonRecord) {
          await tx.billingAddOnPurchase.create({
            data: {
              workspaceId,
              type: addonRecord.type,
              quantity: addonRecord.quantity,
              amountPaise: finalAmount,
              razorpayOrderId: order.id,
              status: 'pending',
            },
          });
        }

        return created;
      });

      return {
        orderId: order.id,
        amountPaise: finalAmount,
        currency,
        keyId: this.razorpay.keyId,
        invoiceId: invoice.id,
      };
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        const raced = await this.checkoutFromExistingIntent(idempotencyKey);
        if (raced) return raced;
      }
      console.error('[billing.createOrder] DB write after Razorpay order failed', {
        workspaceId,
        idempotencyKey,
        orderId: order.id,
        err,
      });
      throw err;
    }
  }

  async verifyOrder(
    workspaceId: string,
    params: {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
    }
  ) {
    const valid = verifyRazorpayPaymentSignature(
      params.razorpay_order_id,
      params.razorpay_payment_id,
      params.razorpay_signature,
      config.razorpay.keySecret
    );
    if (!valid) throw new Error('Invalid payment signature');

    const invoice = await prisma.billingInvoice.findFirst({
      where: {
        workspaceId,
        razorpayOrderId: params.razorpay_order_id,
      },
    });
    if (!invoice) throw new Error('Invoice not found for this order');

    if (invoice.status === 'paid') {
      const wallet =
        invoice.type === 'wallet_topup' ? await getWalletSummary(workspaceId) : undefined;
      return { ok: true, invoiceId: invoice.id, alreadySettled: true, wallet };
    }

    const intent = await prisma.paymentIntent.findFirst({
      where: { razorpayOrderId: params.razorpay_order_id },
    });
    if (intent?.status === 'success') {
      const wallet =
        invoice.type === 'wallet_topup' ? await getWalletSummary(workspaceId) : undefined;
      return { ok: true, invoiceId: invoice.id, alreadySettled: true, wallet };
    }

    const payment = await this.razorpay.fetchPayment(params.razorpay_payment_id);
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      throw new Error(`Payment not successful: ${payment.status}`);
    }

    const settle = await prisma.$transaction(async (tx) =>
      this.settlePaidOrder(tx, {
        invoice,
        paymentId: params.razorpay_payment_id,
      })
    );

    if (invoice.type === 'wallet_topup' /* || invoice.type === 'wallet_auto_recharge_setup' */) {
      await persistWalletPaymentMethod(workspaceId, payment, this.razorpay);
    }

    if (!settle.alreadySettled) {
      void this.notifyInvoicePayment(invoice, true);
    }

    const wallet =
      invoice.type === 'wallet_topup' /* || invoice.type === 'wallet_auto_recharge_setup' */
        ? await getWalletSummary(workspaceId)
        : undefined;

    return {
      ok: true,
      invoiceId: invoice.id,
      alreadySettled: settle.alreadySettled,
      wallet,
    };
  }

  /* AUTO_RECHARGE_DISABLED — re-enable later
  async createAutoRechargeSetup(workspaceId: string) {
    await ensureWallet(workspaceId);
    const customerId = await ensureRazorpayCustomer(workspaceId, this.razorpay);
    const amountPaise = MIN_WALLET_TOPUP_PAISE;
    const order = await this.razorpay.createOrder({
      amountPaise,
      receipt: `auto_setup_${workspaceId.slice(-8)}_${Date.now()}`,
      notes: {
        workspaceId,
        purpose: 'wallet_auto_recharge_setup',
      },
    });

    const invoice = await prisma.billingInvoice.create({
      data: {
        workspaceId,
        razorpayOrderId: order.id,
        type: 'wallet_auto_recharge_setup',
        amountPaise,
        currency: 'INR',
        status: 'created',
        description: 'Save payment method for auto-recharge',
        metadata: { purpose: 'wallet_auto_recharge_setup' },
      },
    });

    return {
      checkoutMode: 'order' as const,
      orderId: order.id,
      amountPaise,
      currency: 'INR' as const,
      keyId: this.razorpay.keyId,
      customerId,
      savePaymentMethod: true as const,
      invoiceId: invoice.id,
    };
  }
  */

  async updateWallet(
    workspaceId: string,
    params: {
      lowBalanceThresholdPaise?: number;
      autoRechargeEnabled?: boolean;
      autoRechargeAmountPaise?: number;
    }
  ) {
    /* AUTO_RECHARGE_DISABLED — re-enable later
    if (params.autoRechargeEnabled === true) {
      await syncRazorpayTokenForWorkspace(workspaceId, this.razorpay);
    }
    */
    return updateWalletSettings(workspaceId, params);
  }

  async getWallet(workspaceId: string) {
    return getWalletSummary(workspaceId);
    /* AUTO_RECHARGE_DISABLED — re-enable later
    let wallet = await getWalletSummary(workspaceId);
    if (!wallet.hasPaymentMethod) {
      await syncRazorpayTokenForWorkspace(workspaceId, this.razorpay);
      wallet = await getWalletSummary(workspaceId);
    }
    if (!wallet.autoRechargeEnabled && wallet.hasPaymentMethod) {
      const setupPaid = await prisma.billingInvoice.findFirst({
        where: { workspaceId, type: 'wallet_auto_recharge_setup', status: 'paid' },
        select: { id: true },
      });
      if (setupPaid) {
        await enableWalletAutoRecharge(workspaceId);
        wallet = await getWalletSummary(workspaceId);
      }
    }
    return wallet;
    */
  }

  async validateCoupon(body: { code: string; amountPaise: number; planId?: string }) {
    let planSlug: string | undefined;
    if (body.planId) {
      const plan = await prisma.subscriptionPlan.findFirst({
        where: { OR: [{ id: body.planId }, { slug: body.planId }] },
        select: { slug: true },
      });
      planSlug = plan?.slug;
    }
    return validateDiscountCoupon({
      code: body.code,
      amountPaise: body.amountPaise,
      planSlug,
    });
  }

  async createSubscription(workspaceId: string, body: CreateSubscriptionBody) {
    const billingCycle: BillingCycle = body.billingCycle ?? 'monthly';
    const currency = await this.workspaceCurrency(workspaceId);
    let plan = await prisma.subscriptionPlan.findFirst({
      where: {
        OR: [{ id: body.planId }, { slug: body.planId }],
        isActive: true,
      },
    });
    if (!plan) {
      await seedSubscriptionPlans();
      plan = await prisma.subscriptionPlan.findFirst({
        where: {
          OR: [{ id: body.planId }, { slug: body.planId }],
          isActive: true,
        },
      });
    }
    if (!plan) throw new Error('Plan not found');

    const razorpayPlanId = resolveCheckoutRazorpayPlanId(plan, billingCycle, currency);
    const amountMinor = planAmountMinor(plan, billingCycle, currency);

    if (!amountMinor) {
      throw new Error('This plan is not available for online checkout');
    }

    const hasValidRazorpayPlan = Boolean(razorpayPlanId);
    // Recurring for INR + USD once plan_id exists. start_at is required on this Razorpay
    // account (see RazorpayService.createSubscription) — omit → opaque Validation failed.
    const useRecurring =
      config.razorpay.recurringEnabled &&
      hasValidRazorpayPlan &&
      !body.couponCode?.trim();

    if (useRecurring) {
      // ponytail: create-subscription schema is plan_id + total_count (+ boolean customer_notify + start_at).
      // customer_id/notify_info are not create params — Razorpay returns opaque "Validation failed".
      const customerId = await ensureRazorpayCustomer(workspaceId, this.razorpay);
      const totalCount = billingCycle === 'annual' ? 10 : 120;
      const rzSub = await this.razorpay.createSubscription({
        planId: razorpayPlanId!,
        totalCount,
        customerNotify: true,
        notes: { workspaceId, planId: plan.id, billingCycle, currency },
      });

      const billingSub = await prisma.billingSubscription.create({
        data: {
          workspaceId,
          planId: plan.id,
          razorpaySubscriptionId: rzSub.id,
          razorpayCustomerId: customerId,
          razorpayPlanId: razorpayPlanId!,
          status: rzSub.status,
          billingCycle,
        },
      });

      return {
        checkoutMode: 'subscription' as const,
        subscriptionId: rzSub.id,
        customerId,
        billingSubscriptionId: billingSub.id,
        keyId: this.razorpay.keyId,
        plan: { id: plan.id, name: plan.name, slug: plan.slug },
        billingCycle,
        amountPaise: amountMinor,
        currency,
        razorpayPlanId: razorpayPlanId!,
      };
    }

    if (
      config.razorpay.recurringEnabled &&
      !hasValidRazorpayPlan &&
      !body.couponCode?.trim()
    ) {
      const cycleKey = billingCycle === 'annual' ? 'ANNUAL' : 'MONTHLY';
      const usdHint =
        currency === 'USD'
          ? ` Store razorpayPlanId${billingCycle === 'annual' ? 'Annual' : 'Monthly'}Usd on the plan (re-run npm run plans:seed).`
          : ` Set RAZORPAY_PLAN_${plan.slug.toUpperCase()}_${cycleKey} in .env or run npm run razorpay:sync-plans.`;
      throw new Error(
        `Razorpay plan ID missing for ${plan.slug} (${billingCycle}, ${currency}).${usdHint}`
      );
    }

    // Coupon path or non-recurring (no plan id / recurring disabled) → one-time order.
    return this.createPlanPurchaseOrder(
      workspaceId,
      plan,
      billingCycle,
      amountMinor,
      currency,
      body.couponCode
    );
  }

  private async createPlanPurchaseOrder(
    workspaceId: string,
    plan: { id: string; slug: string; name: string; features: unknown },
    billingCycle: BillingCycle,
    amountPaise: number,
    currency: BillingCurrency,
    couponCode?: string
  ) {
    let chargePaise = amountPaise;
    let couponMeta:
      | {
          couponId: string;
          couponCode: string;
          originalAmountPaise: number;
          discountPaise: number;
        }
      | undefined;

    if (couponCode?.trim()) {
      const validated = await validateDiscountCoupon({
        code: couponCode,
        amountPaise,
        planSlug: plan.slug,
      });
      if (!validated.valid) throw new Error(validated.reason);
      chargePaise = validated.finalAmountPaise;
      couponMeta = {
        couponId: validated.couponId,
        couponCode: validated.code,
        originalAmountPaise: validated.originalAmountPaise,
        discountPaise: validated.discountPaise,
      };
    }

    const purposeKey = couponMeta
      ? `plan_purchase:${currency}:${plan.id}:${billingCycle}:${chargePaise}:coupon:${couponMeta.couponId}`
      : `plan_purchase:${currency}:${plan.id}:${billingCycle}:${chargePaise}`;
    const idempotencyKey = buildServerIdempotencyKey(workspaceId, purposeKey);

    const existing = await this.checkoutFromExistingIntent(idempotencyKey);
    if (existing) {
      return {
        checkoutMode: 'order' as const,
        orderId: existing.orderId,
        amountPaise: existing.amountPaise,
        currency: existing.currency as BillingCurrency,
        keyId: this.razorpay.keyId,
        plan: { id: plan.id, name: plan.name, slug: plan.slug },
        billingCycle,
        recurring: false as const,
      };
    }

    let intent;
    try {
      intent = await prisma.paymentIntent.create({
        data: {
          idempotencyKey,
          workspaceId,
          amount: chargePaise,
          currency,
          status: 'pending',
        },
      });
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        const raced = await this.checkoutFromExistingIntent(idempotencyKey);
        if (raced) {
          return {
            checkoutMode: 'order' as const,
            orderId: raced.orderId,
            amountPaise: raced.amountPaise,
            currency: raced.currency as BillingCurrency,
            keyId: this.razorpay.keyId,
            plan: { id: plan.id, name: plan.name, slug: plan.slug },
            billingCycle,
            recurring: false as const,
          };
        }
        console.error('[billing.createPlanPurchaseOrder] P2002 without usable PaymentIntent', {
          workspaceId,
          idempotencyKey,
        });
        throw new Error('Payment order is already being created. Please retry shortly.');
      }
      throw err;
    }

    let order: { id: string };
    try {
      order = await this.razorpay.createOrder({
        amountPaise: chargePaise,
        currency,
        receipt: `plan_${plan.slug}_${Date.now()}`,
        notes: {
          workspaceId,
          purpose: 'plan_purchase',
          planId: plan.id,
          billingCycle,
          currency,
          ...(couponMeta ? { couponId: couponMeta.couponId, couponCode: couponMeta.couponCode } : {}),
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[billing.createPlanPurchaseOrder] Razorpay createOrder failed', {
        workspaceId,
        idempotencyKey,
        err,
      });
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'failed', failureReason: reason.slice(0, 500) },
      });
      throw err;
    }

    await prisma.$transaction(async (tx) => {
      const invoice = await tx.billingInvoice.create({
        data: {
          workspaceId,
          razorpayOrderId: order.id,
          type: 'plan_purchase',
          amountPaise: chargePaise,
          currency,
          status: 'created',
          description: `${plan.name} plan (${billingCycle})${couponMeta ? ` · ${couponMeta.couponCode}` : ''}`,
          metadata: {
            planId: plan.id,
            billingCycle,
            ...(couponMeta ?? {}),
          } as Prisma.InputJsonValue,
        },
      });
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          razorpayOrderId: order.id,
          billingInvoiceId: invoice.id,
        },
      });
    });

    return {
      checkoutMode: 'order' as const,
      orderId: order.id,
      amountPaise: chargePaise,
      currency,
      keyId: this.razorpay.keyId,
      plan: { id: plan.id, name: plan.name, slug: plan.slug },
      billingCycle,
      recurring: false as const,
      ...(couponMeta
        ? {
            coupon: {
              code: couponMeta.couponCode,
              discountPaise: couponMeta.discountPaise,
              originalAmountPaise: couponMeta.originalAmountPaise,
            },
          }
        : {}),
    };
  }

  private async ensurePlanPurchaseCouponRedemption(
    tx: Prisma.TransactionClient,
    invoice: {
      id: string;
      workspaceId: string;
      metadata: Prisma.JsonValue | null;
      paidAt?: Date | null;
    },
    options?: { incrementCount?: boolean }
  ) {
    const purchaseMeta = (invoice.metadata ?? {}) as {
      couponId?: string;
      discountPaise?: number;
    };
    if (!purchaseMeta.couponId) return;
    await recordCouponRedemption(
      {
        couponId: purchaseMeta.couponId,
        workspaceId: invoice.workspaceId,
        discountAmountPaise: purchaseMeta.discountPaise ?? 0,
        invoiceId: invoice.id,
        incrementCount: options?.incrementCount,
        createdAt: invoice.paidAt ?? undefined,
      },
      tx
    );
    await creditCouponBonusWalletCredits({
      couponId: purchaseMeta.couponId,
      workspaceId: invoice.workspaceId,
      invoiceId: invoice.id,
      tx,
    });
  }

  private async activatePlanPurchase(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    metadata: Prisma.JsonValue | null
  ) {
    const meta = (metadata ?? {}) as { planId?: string; billingCycle?: BillingCycle };
    if (!meta.planId) return;

    const plan = await tx.subscriptionPlan.findUnique({ where: { id: meta.planId } });
    if (!plan) return;

    const billingCycle = meta.billingCycle ?? 'monthly';
    const periodEnd = new Date();
    if (billingCycle === 'annual') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    await tx.billingSubscription.create({
      data: {
        workspaceId,
        planId: plan.id,
        status: 'active',
        billingCycle,
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
      },
    });

    await tx.workspace.update({
      where: { id: workspaceId },
      data: {
        planId: plan.id,
        ...paidActivationWorkspaceFields(),
      },
    });

    await syncWorkspaceLimitsFromPlanFeatures(workspaceId, plan.features as PlanFeatures, tx);
  }

  async verifySubscriptionPayment(
    workspaceId: string,
    params: {
      razorpay_payment_id: string;
      razorpay_subscription_id: string;
      razorpay_signature: string;
    }
  ) {
    const valid = verifyRazorpaySubscriptionSignature(
      params.razorpay_payment_id,
      params.razorpay_subscription_id,
      params.razorpay_signature,
      config.razorpay.keySecret
    );
    if (!valid) throw new Error('Invalid subscription payment signature');

    const billingSub = await prisma.billingSubscription.findFirst({
      where: {
        workspaceId,
        razorpaySubscriptionId: params.razorpay_subscription_id,
      },
      include: { plan: { select: { id: true, name: true, priceMonthlyPaise: true, priceAnnualPaise: true, features: true } } },
    });
    if (!billingSub) throw new Error('Billing subscription not found');

    const rzSub = await this.razorpay.fetchSubscription(params.razorpay_subscription_id);
    const payment = await this.razorpay.fetchPayment(params.razorpay_payment_id);

    if (
      !subscriptionCheckoutPaymentOk({
        paymentStatus: String(payment.status ?? ''),
        subscriptionStatus: String(rzSub.status ?? ''),
      })
    ) {
      throw new Error(
        `Payment not successful: ${payment.status} (subscription ${rzSub.status})`
      );
    }

    const paymentCurrency =
      typeof payment.currency === 'string' && payment.currency
        ? String(payment.currency).toUpperCase()
        : 'INR';
    const amountPaise =
      (typeof payment.amount === 'number' ? payment.amount : null) ??
      (billingSub.billingCycle === 'annual'
        ? billingSub.plan.priceAnnualPaise
        : billingSub.plan.priceMonthlyPaise);

    const existingInvoice = await prisma.billingInvoice.findFirst({
      where: { razorpayPaymentId: params.razorpay_payment_id },
    });

    await prisma.$transaction(async (tx) => {
      await tx.billingSubscription.update({
        where: { id: billingSub.id },
        data: {
          status: rzSub.status,
          razorpayCustomerId: rzSub.customer_id ?? billingSub.razorpayCustomerId,
          currentPeriodStart: rzSub.current_start
            ? new Date(rzSub.current_start * 1000)
            : undefined,
          currentPeriodEnd: rzSub.current_end ? new Date(rzSub.current_end * 1000) : undefined,
        },
      });

      if (!existingInvoice) {
        await tx.billingInvoice.create({
          data: {
            workspaceId,
            subscriptionId: billingSub.id,
            razorpayPaymentId: params.razorpay_payment_id,
            type: 'subscription',
            amountPaise: amountPaise ?? 0,
            currency: paymentCurrency,
            status: 'paid',
            paidAt: new Date(),
            description: `${billingSub.plan.name} subscription`,
          },
        });
      }

      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          planId: billingSub.planId,
          ...paidActivationWorkspaceFields(),
        },
      });

      await syncWorkspaceLimitsFromPlanFeatures(
        workspaceId,
        billingSub.plan.features as PlanFeatures,
        tx
      );

      await creditPlanWalletCredits({
        workspaceId,
        plan: {
          name: billingSub.plan.name,
          features: billingSub.plan.features as PlanFeatures,
        },
        billingCycle: billingSub.billingCycle as BillingCycle,
        source: 'subscription_payment',
        externalId: params.razorpay_payment_id,
        tx,
      });
    });

    console.log('[billing.verifySubscriptionPayment] workspace plan activated', {
      workspaceId,
      planId: billingSub.planId,
      razorpaySubscriptionId: params.razorpay_subscription_id,
      paymentStatus: payment.status,
      subscriptionStatus: rzSub.status,
    });

    const { markBillingOfferPaidBySubscription } = await import(
      '../../services/billingOffers.js'
    );
    await markBillingOfferPaidBySubscription(
      params.razorpay_subscription_id,
      'verifySubscriptionPayment'
    );

    await persistWalletPaymentMethod(
      workspaceId,
      {
        token_id: payment.token_id,
        customer_id:
          payment.customer_id ?? rzSub.customer_id ?? billingSub.razorpayCustomerId ?? undefined,
      },
      this.razorpay
    );

    return { ok: true, subscriptionStatus: 'active', planId: billingSub.planId };
  }

  async cancelSubscription(workspaceId: string, cancelAtPeriodEnd = true) {
    const billingSub = await prisma.billingSubscription.findFirst({
      where: {
        workspaceId,
        status: { in: [...LIVE_BILLING_SUB_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!billingSub) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { subscriptionStatus: true },
      });
      if (
        workspace &&
        ['active', 'authenticated'].includes(workspace.subscriptionStatus)
      ) {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { subscriptionStatus: 'cancelled', planId: null },
        });
        return { ok: true, status: 'cancelled', cancelAtPeriodEnd: false };
      }
      throw new Error('No active billing subscription found');
    }

    if (!billingSub.razorpaySubscriptionId) {
      await prisma.billingSubscription.update({
        where: { id: billingSub.id },
        data: {
          status: 'cancelled',
          cancelAtPeriodEnd: false,
          cancelledAt: new Date(),
        },
      });
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { subscriptionStatus: 'cancelled', planId: null },
      });
      return { ok: true, status: 'cancelled', cancelAtPeriodEnd: false };
    }

    const rzSub = await this.razorpay.cancelSubscription(
      billingSub.razorpaySubscriptionId,
      cancelAtPeriodEnd
    );

    await prisma.billingSubscription.update({
      where: { id: billingSub.id },
      data: {
        status: rzSub.status,
        cancelAtPeriodEnd,
        cancelledAt: cancelAtPeriodEnd ? undefined : new Date(),
      },
    });

    if (!cancelAtPeriodEnd) {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { subscriptionStatus: 'cancelled', planId: null },
      });
    }

    return { ok: true, status: rzSub.status, cancelAtPeriodEnd };
  }

  async pauseSubscription(workspaceId: string) {
    const billingSub = await this.getActiveBillingSubscription(workspaceId);
    if (!billingSub.razorpaySubscriptionId) throw new Error('No Razorpay subscription linked');

    const rzSub = await this.razorpay.pauseSubscription(billingSub.razorpaySubscriptionId);

    await prisma.billingSubscription.update({
      where: { id: billingSub.id },
      data: { status: rzSub.status, pausedAt: new Date() },
    });

    return { ok: true, status: rzSub.status };
  }

  async resumeSubscription(workspaceId: string) {
    const billingSub = await prisma.billingSubscription.findFirst({
      where: { workspaceId, status: { in: ['paused', 'halted'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!billingSub?.razorpaySubscriptionId) {
      throw new Error('No paused subscription found');
    }

    const rzSub = await this.razorpay.resumeSubscription(billingSub.razorpaySubscriptionId);

    await prisma.billingSubscription.update({
      where: { id: billingSub.id },
      data: { status: rzSub.status, pausedAt: null },
    });

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: paidActivationWorkspaceFields(),
    });

    return { ok: true, status: rzSub.status };
  }

  async refundPayment(workspaceId: string, paymentId: string, amountPaise?: number, reason?: string) {
    const invoice = await prisma.billingInvoice.findFirst({
      where: { workspaceId, razorpayPaymentId: paymentId, status: 'paid' },
    });
    if (!invoice) throw new Error('Paid invoice not found for this payment');

    const refund = await this.razorpay.refundPayment(paymentId, amountPaise, {
      workspaceId,
      reason: reason ?? 'customer_request',
    });

    await prisma.billingInvoice.update({
      where: { id: invoice.id },
      data: { status: 'refunded' },
    });

    return { ok: true, refundId: refund.id, status: refund.status };
  }

  // --- Webhook handlers ---

  async handlePaymentCaptured(payload: RazorpayWebhookPayload | Record<string, unknown>) {
    const payment = webhookPaymentEntity(payload) ?? webhookEntity(payload, 'payment');
    if (!payment?.id) {
      console.error('[billing.handlePaymentCaptured] Missing payment entity', { payload });
      return;
    }

    const orderId = payment.order_id as string | undefined;
    if (!orderId) {
      console.error('[billing.handlePaymentCaptured] Missing order_id', {
        paymentId: payment.id,
      });
      return;
    }

    const invoice = await prisma.billingInvoice.findFirst({
      where: { razorpayOrderId: orderId },
    });
    if (!invoice) {
      console.error('[billing.handlePaymentCaptured] Invoice not found', {
        orderId,
        paymentId: payment.id,
      });
      return;
    }
    if (invoice.status === 'paid') return;

    const workspaceId = invoice.workspaceId;
    const paymentId = payment.id as string;

    let paymentCreds: ReturnType<typeof extractPaymentCredentials> | null = null;
    if (invoice.type === 'wallet_topup' /* || invoice.type === 'wallet_auto_recharge_setup' */) {
      const fetchedPayment = await this.razorpay.fetchPayment(paymentId);
      paymentCreds = extractPaymentCredentials(fetchedPayment);
    }

    const settle = await prisma.$transaction(async (tx) =>
      this.settlePaidOrder(tx, { invoice, paymentId })
    );

    if (paymentCreds) {
      await saveWalletPaymentCredentials(workspaceId, paymentCreds);
    }

    if (!settle.alreadySettled) {
      void this.notifyInvoicePayment(invoice, true);
    }
  }

  async handlePaymentFailed(payload: RazorpayWebhookPayload | Record<string, unknown>) {
    const payment = webhookPaymentEntity(payload) ?? webhookEntity(payload, 'payment');
    if (!payment?.order_id) {
      console.error('[billing.handlePaymentFailed] Missing payment.order_id', { payload });
      return;
    }

    const orderId = payment.order_id as string;
    const paymentId = typeof payment.id === 'string' ? payment.id : undefined;
    const failureReason =
      (typeof payment.error_description === 'string' && payment.error_description) ||
      (typeof payment.error_reason === 'string' && payment.error_reason) ||
      (typeof payment.error_code === 'string' && payment.error_code) ||
      'payment_failed';

    const invoice = await prisma.billingInvoice.findFirst({
      where: { razorpayOrderId: orderId },
    });

    await prisma.$transaction(async (tx) => {
      await tx.paymentIntent.updateMany({
        where: {
          razorpayOrderId: orderId,
          status: 'pending',
        },
        data: {
          status: 'failed',
          failureReason: failureReason.slice(0, 500),
          ...(paymentId ? { razorpayPaymentId: paymentId } : {}),
        },
      });

      await tx.billingInvoice.updateMany({
        where: {
          razorpayOrderId: orderId,
          status: { notIn: ['paid'] },
        },
        data: { status: 'failed' },
      });

      await tx.billingAddOnPurchase.updateMany({
        where: {
          razorpayOrderId: orderId,
          status: { notIn: ['paid'] },
        },
        data: { status: 'failed' },
      });
    });

    if (invoice && invoice.status !== 'paid' && invoice.status !== 'failed') {
      void this.notifyInvoicePayment(invoice, false, failureReason);
    }
  }

  /**
   * First caller to transition PaymentIntent pending→success (or invoice→paid when no intent)
   * applies credits. Subsequent verify/webhook calls return alreadySettled without re-crediting.
   */
  private async settlePaidOrder(
    tx: Prisma.TransactionClient,
    params: {
      invoice: {
        id: string;
        workspaceId: string;
        razorpayOrderId: string | null;
        type: string;
        metadata: Prisma.JsonValue | null;
        amountPaise: number;
        status: string;
      };
      paymentId: string;
    }
  ): Promise<{ alreadySettled: boolean }> {
    const { invoice, paymentId } = params;
    const workspaceId = invoice.workspaceId;
    const orderId = invoice.razorpayOrderId;

    const intent = orderId
      ? await tx.paymentIntent.findFirst({ where: { razorpayOrderId: orderId } })
      : null;

    if (intent?.status === 'success' || invoice.status === 'paid') {
      if (invoice.type === 'plan_purchase') {
        await this.ensurePlanPurchaseCouponRedemption(tx, invoice, { incrementCount: false });
      }
      return { alreadySettled: true };
    }

    if (intent) {
      const claimed = await tx.paymentIntent.updateMany({
        where: { id: intent.id, status: 'pending' },
        data: {
          status: 'success',
          razorpayPaymentId: paymentId,
          failureReason: null,
        },
      });
      if (claimed.count === 0) {
        return { alreadySettled: true };
      }

      await tx.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          razorpayPaymentId: paymentId,
          status: 'paid',
          paidAt: new Date(),
        },
      });
    } else {
      const claimed = await tx.billingInvoice.updateMany({
        where: { id: invoice.id, status: { not: 'paid' } },
        data: {
          razorpayPaymentId: paymentId,
          status: 'paid',
          paidAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        return { alreadySettled: true };
      }
    }

    const addon = orderId
      ? await tx.billingAddOnPurchase.findFirst({
          where: { workspaceId, razorpayOrderId: orderId },
        })
      : null;

    if (addon && addon.status !== 'paid') {
      await tx.billingAddOnPurchase.update({
        where: { id: addon.id },
        data: {
          razorpayPaymentId: paymentId,
          status: 'paid',
          validUntil: this.addonValidUntil(addon.type as AddOnType),
        },
      });
      await this.applyAddonToWorkspace(tx, workspaceId, addon.type as AddOnType, addon.quantity);
    }

    if (invoice.type === 'custom_plan') {
      const workspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
      const saved = readCustomPlanInput(workspace?.customPlanSelection);
      if (saved) {
        await this.applyCustomPlanLimits(tx, workspaceId, saved.input);
      }
      await tx.workspace.update({
        where: { id: workspaceId },
        data: paidActivationWorkspaceFields(),
      });
    }

    if (invoice.type === 'plan_purchase') {
      await this.activatePlanPurchase(tx, workspaceId, invoice.metadata);
      await this.ensurePlanPurchaseCouponRedemption(tx, invoice);
      const purchaseMeta = (invoice.metadata ?? {}) as {
        planId?: string;
        billingCycle?: BillingCycle;
      };
      if (purchaseMeta.planId) {
        const plan = await tx.subscriptionPlan.findUnique({ where: { id: purchaseMeta.planId } });
        if (plan) {
          await creditPlanWalletCredits({
            workspaceId,
            plan: { name: plan.name, features: plan.features as PlanFeatures },
            billingCycle: purchaseMeta.billingCycle ?? 'monthly',
            source: 'plan_purchase',
            externalId: invoice.id,
            tx,
          });
        }
      }
    }

    if (invoice.type === 'wallet_topup') {
      await creditWallet({
        workspaceId,
        amountPaise: walletTopupCreditPaise(invoice),
        category: 'wallet_topup',
        description: 'Wallet recharge',
        referenceType: 'invoice',
        referenceId: invoice.id,
        idempotencyKey: `topup:${invoice.id}`,
        tx,
      });
    }

    /* AUTO_RECHARGE_DISABLED — re-enable later
    if (invoice.type === 'wallet_auto_recharge') { ... }
    if (invoice.type === 'wallet_auto_recharge_setup') { ... }
    */

    return { alreadySettled: false };
  }

  private async checkoutFromExistingIntent(idempotencyKey: string): Promise<{
    orderId: string;
    amountPaise: number;
    currency: string;
    keyId: string;
    invoiceId?: string;
  } | null> {
    const existing = await prisma.paymentIntent.findUnique({
      where: { idempotencyKey },
    });
    if (!existing?.razorpayOrderId) return null;
    if (existing.status === 'failed') return null;

    return {
      orderId: existing.razorpayOrderId,
      amountPaise: existing.amount,
      currency: existing.currency,
      keyId: this.razorpay.keyId,
      invoiceId: existing.billingInvoiceId ?? undefined,
    };
  }

  async handleSubscriptionEvent(
    event: string,
    payload: Record<string, unknown>
  ) {
    const sub = webhookEntity(payload, 'subscription');
    if (!sub?.id) return;

    const billingSub = await prisma.billingSubscription.findFirst({
      where: { razorpaySubscriptionId: sub.id as string },
      include: { plan: true },
    });
    if (!billingSub) return;

    const workspaceId = billingSub.workspaceId;
    const status = sub.status as string;

    await prisma.billingSubscription.update({
      where: { id: billingSub.id },
      data: {
        status,
        currentPeriodStart: sub.current_start
          ? new Date((sub.current_start as number) * 1000)
          : undefined,
        currentPeriodEnd: sub.current_end
          ? new Date((sub.current_end as number) * 1000)
          : undefined,
        cancelledAt:
          event === 'subscription.cancelled' ? new Date() : billingSub.cancelledAt,
        pausedAt: event === 'subscription.paused' ? new Date() : billingSub.pausedAt,
      },
    });

    if (
      event === 'subscription.activated' ||
      event === 'subscription.authenticated' ||
      event === 'subscription.resumed'
    ) {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          planId: billingSub.planId,
          ...paidActivationWorkspaceFields(),
        },
      });
      if (billingSub.plan) {
        await syncWorkspaceLimitsFromPlanFeatures(
          workspaceId,
          billingSub.plan.features as PlanFeatures
        );
      }
      console.log('[billing.handleSubscriptionEvent] workspace plan activated', {
        event,
        workspaceId,
        planId: billingSub.planId,
        razorpaySubscriptionId: billingSub.razorpaySubscriptionId,
        status,
      });
      const { markBillingOfferPaidBySubscription } = await import(
        '../../services/billingOffers.js'
      );
      await markBillingOfferPaidBySubscription(
        billingSub.razorpaySubscriptionId!,
        event
      );
    }

    if (event === 'subscription.cancelled') {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { subscriptionStatus: 'cancelled' },
      });
    }

    if (event === 'subscription.paused' || event === 'subscription.halted') {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { subscriptionStatus: 'past_due' },
      });
    }

    if (event === 'subscription.halted') {
      const amountPaise =
        billingSub.billingCycle === 'annual'
          ? billingSub.plan?.priceAnnualPaise
          : billingSub.plan?.priceMonthlyPaise;
      void import('../../services/notifications/paymentNotify.js').then(({ notifyPaymentOutcome }) =>
        notifyPaymentOutcome({
          workspaceId,
          success: false,
          label: billingSub.plan?.name ?? 'Subscription',
          amountPaise: amountPaise ?? 0,
          currency: 'INR',
          entityType: 'subscription',
          entityId: billingSub.id,
          reason: 'subscription halted',
          metadata: { event },
        })
      );
    }
  }

  async handleSubscriptionCharged(payload: Record<string, unknown>) {
    const payment = webhookEntity(payload, 'payment');
    const sub = webhookEntity(payload, 'subscription');
    if (!payment?.id || !sub?.id) return;

    const billingSub = await prisma.billingSubscription.findFirst({
      where: { razorpaySubscriptionId: sub.id as string },
      include: { plan: true },
    });
    if (!billingSub) return;

    const paymentCurrency =
      typeof payment.currency === 'string' && payment.currency
        ? String(payment.currency).toUpperCase()
        : 'INR';
    const amountPaise =
      (typeof payment.amount === 'number' ? payment.amount : null) ??
      (billingSub.billingCycle === 'annual'
        ? billingSub.plan.priceAnnualPaise
        : billingSub.plan.priceMonthlyPaise);

    const existing = await prisma.billingInvoice.findFirst({
      where: { razorpayPaymentId: payment.id as string },
    });
    if (existing) return;

    await prisma.$transaction(async (tx) => {
      await tx.billingInvoice.create({
        data: {
          workspaceId: billingSub.workspaceId,
          subscriptionId: billingSub.id,
          razorpayPaymentId: payment.id as string,
          type: 'subscription',
          amountPaise: amountPaise ?? 0,
          currency: paymentCurrency,
          status: 'paid',
          paidAt: new Date(),
          description: `${billingSub.plan.name} renewal`,
        },
      });

      await tx.workspace.update({
        where: { id: billingSub.workspaceId },
        data: {
          planId: billingSub.planId,
          ...paidActivationWorkspaceFields(),
        },
      });

      await creditPlanWalletCredits({
        workspaceId: billingSub.workspaceId,
        plan: {
          name: billingSub.plan.name,
          features: billingSub.plan.features as PlanFeatures,
        },
        billingCycle: billingSub.billingCycle as BillingCycle,
        source: 'subscription_renewal',
        externalId: payment.id as string,
        tx,
      });
    });

    console.log('[billing.handleSubscriptionCharged] workspace plan activated', {
      workspaceId: billingSub.workspaceId,
      planId: billingSub.planId,
      razorpaySubscriptionId: billingSub.razorpaySubscriptionId,
      razorpayPaymentId: payment.id,
    });

    const { markBillingOfferPaidBySubscription } = await import(
      '../../services/billingOffers.js'
    );
    await markBillingOfferPaidBySubscription(
      billingSub.razorpaySubscriptionId!,
      'subscription.charged'
    );

    void import('../../services/notifications/paymentNotify.js').then(({ notifyPaymentOutcome }) =>
      notifyPaymentOutcome({
        workspaceId: billingSub.workspaceId,
        success: true,
        label: billingSub.plan.name,
        amountPaise: amountPaise ?? 0,
        currency: paymentCurrency,
        entityType: 'subscription',
        entityId: billingSub.id,
        metadata: { razorpayPaymentId: String(payment.id) },
      })
    );
  }

  /**
   * Resolve razorpay subscription id for an auth payment.
   * Razorpay often omits payment.subscription_id on the $0.50/₹1 auth token.
   */
  private async resolveSubscriptionIdFromAuthPayment(payment: Record<string, unknown>) {
    if (typeof payment.subscription_id === 'string' && payment.subscription_id) {
      return { subscriptionId: payment.subscription_id, via: 'payment.subscription_id' as const };
    }

    const currency = String(payment.currency ?? '').toUpperCase();
    if (currency !== 'INR' && currency !== 'USD') return null;

    const amount = typeof payment.amount === 'number' ? payment.amount : null;
    // Auth tokens are the currency minimum; skip full-price authorizations (orders / links).
    if (amount == null || amount !== minCheckoutMinor(currency as BillingCurrency)) return null;

    const description = typeof payment.description === 'string' ? payment.description : '';
    if (!description.trim()) return null;

    const pending = await prisma.billingOffer.findMany({
      where: {
        status: 'pending',
        offerType: 'subscription',
        currency,
        razorpaySubscriptionId: { not: null },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      include: { plan: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // ponytail: if two identical pending offers, pick newest; upgrade = require subscription_id.
    const subscriptionId = matchSubscriptionIdByCheckoutDescription(
      description,
      pending.map((offer) => ({
        planName: offer.plan.name,
        billingCycle: offer.billingCycle,
        razorpaySubscriptionId: offer.razorpaySubscriptionId!,
      }))
    );
    if (!subscriptionId) return null;

    return { subscriptionId, via: 'pending_offer_description' as const };
  }

  /**
   * Auth-token payments for subscriptions often arrive as payment.authorized
   * (and may never emit subscription.* if those events aren't enabled).
   */
  async handleSubscriptionPaymentAuthorized(payload: Record<string, unknown>) {
    const payment = webhookPaymentEntity(payload) ?? webhookEntity(payload, 'payment');
    if (!payment?.id) return;

    const status =
      typeof payment.status === 'string' && payment.status
        ? String(payment.status)
        : 'authorized';
    if (status !== 'authorized' && status !== 'captured') return;

    const resolved = await this.resolveSubscriptionIdFromAuthPayment(payment);
    if (!resolved) return;

    const { subscriptionId, via } = resolved;
    const billingSub = await prisma.billingSubscription.findFirst({
      where: { razorpaySubscriptionId: subscriptionId },
      include: { plan: true },
    });
    if (!billingSub) {
      console.warn('[billing.handleSubscriptionPaymentAuthorized] no BillingSubscription', {
        razorpayPaymentId: payment.id,
        razorpaySubscriptionId: subscriptionId,
        via,
      });
      return;
    }

    // Already live — still clear any pending billing offer.
    const alreadyLive = LIVE_BILLING_SUB_STATUSES.includes(
      billingSub.status as (typeof LIVE_BILLING_SUB_STATUSES)[number]
    );

    if (!alreadyLive) {
      await prisma.billingSubscription.update({
        where: { id: billingSub.id },
        data: { status: 'authenticated' },
      });
    }

    await prisma.workspace.update({
      where: { id: billingSub.workspaceId },
      data: {
        planId: billingSub.planId,
        ...paidActivationWorkspaceFields(),
      },
    });
    if (billingSub.plan) {
      await syncWorkspaceLimitsFromPlanFeatures(
        billingSub.workspaceId,
        billingSub.plan.features as PlanFeatures
      );
    }

    console.log('[billing.handleSubscriptionPaymentAuthorized] workspace plan activated', {
      workspaceId: billingSub.workspaceId,
      planId: billingSub.planId,
      razorpaySubscriptionId: subscriptionId,
      razorpayPaymentId: payment.id,
      paymentStatus: status,
      via,
    });

    const { markBillingOfferPaidBySubscription } = await import(
      '../../services/billingOffers.js'
    );
    await markBillingOfferPaidBySubscription(subscriptionId, 'payment.authorized');
  }

  async handleInvoicePaid(payload: Record<string, unknown>) {
    const invoice = webhookEntity(payload, 'invoice');
    if (!invoice?.id) return;

    const billingSub = await prisma.billingSubscription.findFirst({
      where: { razorpaySubscriptionId: invoice.subscription_id as string },
    });
    if (!billingSub) return;

    await prisma.billingInvoice.upsert({
      where: { razorpayInvoiceId: invoice.id as string },
      create: {
        workspaceId: billingSub.workspaceId,
        subscriptionId: billingSub.id,
        razorpayInvoiceId: invoice.id as string,
        type: 'subscription',
        amountPaise: invoice.amount as number,
        currency: (invoice.currency as string) ?? 'INR',
        status: 'paid',
        paidAt: new Date(),
        description: 'Razorpay invoice',
      },
      update: { status: 'paid', paidAt: new Date() },
    });
  }

  // --- Helpers ---

  private notifyInvoicePayment(
    invoice: {
      id: string;
      workspaceId: string;
      type: string;
      amountPaise: number;
      currency: string;
      description: string | null;
      metadata: Prisma.JsonValue | null;
    },
    success: boolean,
    reason?: string | null
  ) {
    void import('../../services/notifications/paymentNotify.js').then(
      ({ notifyPaymentOutcome, paymentLabelFromInvoice }) =>
        notifyPaymentOutcome({
          workspaceId: invoice.workspaceId,
          success,
          label: paymentLabelFromInvoice(invoice),
          amountPaise: invoice.amountPaise,
          currency: invoice.currency || 'INR',
          entityType: 'invoice',
          entityId: invoice.id,
          reason: reason ?? null,
          metadata: { invoiceType: invoice.type },
        })
    );
  }

  private async getActiveBillingSubscription(workspaceId: string) {
    const billingSub = await prisma.billingSubscription.findFirst({
      where: {
        workspaceId,
        status: { in: [...LIVE_BILLING_SUB_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!billingSub) throw new Error('No active billing subscription found');
    return billingSub;
  }

  private async addonAmountMinor(
    type: AddOnType,
    quantity: number,
    currency: BillingCurrency
  ): Promise<number> {
    const entry = ADDON_CATALOG.find((item) => item.type === type);
    if (!entry) throw new Error(`Unknown add-on type: ${type}`);
    if (currency === 'USD') {
      return toMinorUnits(entry.usdPerUnit) * quantity;
    }
    const { rate } = await this.getUsdInrRate();
    return this.usdToInrPaise(entry.usdPerUnit, rate) * quantity;
  }

  private usdToInrPaise(usdAmount: number, usdInrRate: number): number {
    return Math.max(100, Math.round(usdAmount * usdInrRate * 100));
  }

  private async getUsdInrRate(): Promise<{ rate: number; fetchedAtMs: number; source: string }> {
    const now = Date.now();
    if (usdInrCache && now - usdInrCache.fetchedAtMs < FX_CACHE_TTL_MS) {
      return usdInrCache;
    }

    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rates?: Record<string, number> };
      const liveRate = Number(json.rates?.INR);
      if (!Number.isFinite(liveRate) || liveRate <= 0) throw new Error('INR rate missing');
      usdInrCache = { rate: liveRate, fetchedAtMs: now, source: 'open.er-api.com' };
      return usdInrCache;
    } catch {
      const fallback = {
        rate: usdInrCache?.rate ?? USD_INR_FALLBACK,
        fetchedAtMs: usdInrCache?.fetchedAtMs ?? now,
        source: usdInrCache ? 'cached' : 'fallback',
      };
      usdInrCache = fallback;
      return fallback;
    }
  }

  private addonValidUntil(type: AddOnType): Date | null {
    if (type === 'ai_tokens') return null;
    const until = new Date();
    until.setMonth(until.getMonth() + 1);
    return until;
  }

  private async applyAddonToWorkspace(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    type: AddOnType,
    quantity: number
  ) {
    const fieldMap: Record<AddOnType, keyof Prisma.WorkspaceUsageLimitsUpdateInput> = {
      contacts: 'contactsLimit',
      team_members: 'teamMembersLimit',
      ai_agents: 'aiAgentsLimit',
      channels: 'channelsLimit',
      ai_tokens: 'aiTokensIncluded',
      campaigns: 'campaignsLimit',
      emails: 'emailsLimit',
    };

    const field = fieldMap[type];
    const existing = await tx.workspaceUsageLimits.findUnique({ where: { workspaceId } });

    if (!existing) {
      const defaults = {
        contactsLimit: 1000,
        teamMembersLimit: 3,
        aiAgentsLimit: 1,
        channelsLimit: 2,
        aiTokensIncluded: 0,
        campaignsLimit: UNLIMITED_USAGE_LIMIT,
        emailsLimit: 0,
      };
      const increment = this.addonIncrement(type, quantity);
      await tx.workspaceUsageLimits.create({
        data: {
          workspaceId,
          ...defaults,
          [field]: (defaults as Record<string, number>)[field as string] + increment,
        },
      });
      return;
    }

    const current = existing[field as keyof typeof existing] as number;
    await tx.workspaceUsageLimits.update({
      where: { workspaceId },
      data: { [field]: current + this.addonIncrement(type, quantity) },
    });
  }

  private addonIncrement(type: AddOnType, quantity: number): number {
    const increments: Record<AddOnType, number> = {
      contacts: 1000 * quantity,
      team_members: quantity,
      ai_agents: quantity,
      channels: quantity,
      ai_tokens: 10000 * quantity,
      campaigns: quantity,
      emails: 1000 * quantity,
    };
    return increments[type];
  }

  private async applyCustomPlanLimits(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    input: { contacts: number; aiAgents: number; teamMembers: number; channels: number; emails: number }
  ) {
    await tx.workspaceUsageLimits.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        contactsLimit: input.contacts,
        teamMembersLimit: input.teamMembers,
        aiAgentsLimit: input.aiAgents,
        channelsLimit: input.channels,
        aiTokensIncluded: 0,
        campaignsLimit: 15,
        emailsLimit: input.emails,
      },
      update: {
        contactsLimit: input.contacts,
        teamMembersLimit: input.teamMembers,
        aiAgentsLimit: input.aiAgents,
        channelsLimit: input.channels,
        emailsLimit: input.emails,
      },
    });
  }

}
