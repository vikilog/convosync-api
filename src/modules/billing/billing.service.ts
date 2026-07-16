import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import {
  verifyRazorpayPaymentSignature,
  verifyRazorpaySubscriptionSignature,
} from '../../utils/crypto.utils.js';
import { normalizeRazorpayError } from '../../utils/razorpay-error.utils.js';
import { readCustomPlanInput } from '../../services/customPlanPricing.js';
import type { PlanFeatures } from '../../services/subscriptionPlans.js';
import { isValidRazorpayPlanId, razorpayPlanIdsFromEnv, type PlanSlug } from '../../services/razorpayPlanSync.js';
import {
  computeTokenBillingCosts,
  getWorkspaceMonthlyTokenUsage,
} from '../../services/workspaceTokenUsage.js';
import type {
  AddOnType,
  BillingCycle,
  CreateOrderBody,
  CreateSubscriptionBody,
  OrderPurpose,
} from './billing.types.js';
import { ADDON_CATALOG } from './billing.types.js';
import { MIN_WALLET_TOPUP_PAISE } from '../../services/wallet.constants.js';
import { creditWallet, getWalletSummary, updateWalletSettings } from '../../services/wallet.service.js';
import {
  ensureRazorpayCustomer,
  extractPaymentCredentials,
  normalizeIndianPhone,
  persistWalletPaymentMethod,
  saveWalletPaymentCredentials,
} from '../../services/razorpayCustomer.service.js';
import type { RazorpayService } from './razorpay.service.js';

const USD_INR_FALLBACK = 83;
const FX_CACHE_TTL_MS = 30 * 60 * 1000;
let usdInrCache: { rate: number; fetchedAtMs: number; source: string } | null = null;

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

function parseFeatureLimit(value: string | number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  const normalized = value.replace(/,/g, '').trim().toLowerCase();
  if (normalized === 'unlimited' || normalized === 'custom') return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class BillingService {
  constructor(private readonly razorpay: RazorpayService) {}

  async listPlans() {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    return plans.map((plan) => ({
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      priceMonthlyPaise: plan.priceMonthlyPaise,
      priceAnnualPaise: plan.priceAnnualPaise,
      razorpayPlanIdMonthly: plan.razorpayPlanIdMonthly,
      razorpayPlanIdAnnual: plan.razorpayPlanIdAnnual,
      features: plan.features,
    }));
  }

  async getWorkspaceBilling(workspaceId: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        plan: true,
        usageLimits: true,
        billingSubscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { plan: true },
        },
      },
    });

    if (!workspace) throw new Error('Workspace not found');

    const activeSub = workspace.billingSubscriptions[0] ?? null;
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

    const [usageSnapshot, connectedChannels, wallet] = await Promise.all([
      this.getUsageSnapshot(workspaceId, workspace.usageLimits),
      this.getConnectedChannels(workspaceId),
      getWalletSummary(workspaceId),
    ]);

    return {
      workspaceId,
      subscriptionStatus: workspace.subscriptionStatus,
      wallet,
      plan: workspace.plan
        ? {
            id: workspace.plan.id,
            slug: workspace.plan.slug,
            name: workspace.plan.name,
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
        unitPaise: this.usdToInrPaise(entry.usdPerUnit, usdInrRate),
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
      if (limit >= Number.MAX_SAFE_INTEGER) {
        return { used, limit: Number.MAX_SAFE_INTEGER, pending: Number.MAX_SAFE_INTEGER };
      }
      return { used, limit, pending: Math.max(0, limit - used) };
    };

    const aiTokenLimit = limitValue(limits?.aiTokensIncluded, 0);
    const tokenCosts = computeTokenBillingCosts({
      used: aiTokenUsage.used,
      costInr: aiTokenUsage.costInr,
      includedTokens: aiTokenLimit,
    });
    const aiTokensSnapshot =
      aiTokenLimit <= 0
        ? {
            used: aiTokenUsage.used,
            limit: Number.MAX_SAFE_INTEGER,
            pending: Number.MAX_SAFE_INTEGER,
            inputTokens: aiTokenUsage.inputTokens,
            outputTokens: aiTokenUsage.outputTokens,
            costInr: tokenCosts.costInr,
            includedCreditInr: tokenCosts.includedCreditInr,
            billedCostInr: tokenCosts.billedCostInr,
          }
        : {
            ...toSnapshotItem(aiTokenUsage.used, aiTokenLimit),
            inputTokens: aiTokenUsage.inputTokens,
            outputTokens: aiTokenUsage.outputTokens,
            costInr: tokenCosts.costInr,
            includedCreditInr: tokenCosts.includedCreditInr,
            billedCostInr: tokenCosts.billedCostInr,
          };

    return {
      contacts: toSnapshotItem(contactsUsed, limitValue(limits?.contactsLimit, 1000)),
      teamMembers: toSnapshotItem(teamMembersUsed, limitValue(limits?.teamMembersLimit, 2)),
      aiAgents: toSnapshotItem(aiAgentsUsed, limitValue(limits?.aiAgentsLimit, 1)),
      channels: toSnapshotItem(channelsUsed, limitValue(limits?.channelsLimit, 2)),
      campaigns: toSnapshotItem(campaignsUsed, limitValue(limits?.campaignsLimit, 3)),
      emails: toSnapshotItem(emailsUsed, limitValue(limits?.emailsLimit, 1000)),
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
        const { rate } = await this.getUsdInrRate();
        finalAmount = this.usdToInrPaise(monthly, rate);
        invoiceType = 'custom_plan';
      }
    }

    if (addonType) {
      finalAmount = await this.addonAmountPaise(addonType, quantity ?? 1);
      invoiceType = 'addon';
      addonRecord = { type: addonType, quantity: quantity ?? 1 };
    }

    if (purpose === 'wallet_topup') {
      if (!amountPaise || amountPaise < MIN_WALLET_TOPUP_PAISE) {
        throw new Error('Minimum wallet top-up is ₹100.');
      }
      finalAmount = amountPaise;
      invoiceType = 'wallet_topup';
      const creditPaise = creditAmountPaise ?? amountPaise;
      walletTopupMeta = {
        purpose: 'wallet_topup',
        creditAmountPaise: creditPaise,
      };
    }

    if (!finalAmount || finalAmount < 100) {
      throw new Error('Invalid order amount. Minimum is 100 paise (₹1).');
    }

    const receipt = `convosync_${workspaceId.slice(-8)}_${Date.now()}`;
    const order = await this.razorpay.createOrder({
      amountPaise: finalAmount,
      receipt,
      notes: {
        workspaceId,
        purpose: invoiceType,
        ...(addonType ? { addonType, quantity: String(quantity ?? 1) } : {}),
      },
    });

    const invoice = await prisma.billingInvoice.create({
      data: {
        workspaceId,
        razorpayOrderId: order.id,
        type: invoiceType,
        amountPaise: finalAmount,
        currency: 'INR',
        status: 'created',
        description: description ?? `${invoiceType} payment`,
        metadata: (walletTopupMeta ??
          ({ purpose: invoiceType, addonType, quantity } as Prisma.InputJsonValue)),
      },
    });

    if (addonRecord) {
      await prisma.billingAddOnPurchase.create({
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

    return {
      orderId: order.id,
      amountPaise: finalAmount,
      currency: 'INR',
      keyId: this.razorpay.keyId,
      invoiceId: invoice.id,
    };
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

    const payment = await this.razorpay.fetchPayment(params.razorpay_payment_id);
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      throw new Error(`Payment not successful: ${payment.status}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          razorpayPaymentId: params.razorpay_payment_id,
          status: 'paid',
          paidAt: new Date(),
        },
      });

      const addon = await tx.billingAddOnPurchase.findFirst({
        where: { workspaceId, razorpayOrderId: params.razorpay_order_id },
      });

      if (addon) {
        await tx.billingAddOnPurchase.update({
          where: { id: addon.id },
          data: {
            razorpayPaymentId: params.razorpay_payment_id,
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
          data: { subscriptionStatus: 'active' },
        });
      }

      if (invoice.type === 'plan_purchase') {
        await this.activatePlanPurchase(tx, workspaceId, invoice.metadata);
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
      if (invoice.type === 'wallet_auto_recharge_setup') {
        await creditWallet({
          workspaceId,
          amountPaise: invoice.amountPaise,
          category: 'wallet_topup',
          description: 'Payment method setup',
          referenceType: 'invoice',
          referenceId: invoice.id,
          idempotencyKey: `auto-setup:${invoice.id}`,
          tx,
        });
      }
      */
    });

    if (invoice.type === 'wallet_topup' /* || invoice.type === 'wallet_auto_recharge_setup' */) {
      await persistWalletPaymentMethod(workspaceId, payment, this.razorpay);
    }

    const wallet =
      invoice.type === 'wallet_topup' /* || invoice.type === 'wallet_auto_recharge_setup' */
        ? await getWalletSummary(workspaceId)
        : undefined;

    return { ok: true, invoiceId: invoice.id, wallet };
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

  async createSubscription(workspaceId: string, body: CreateSubscriptionBody) {
    const billingCycle: BillingCycle = body.billingCycle ?? 'monthly';
    const plan = await prisma.subscriptionPlan.findFirst({
      where: { OR: [{ id: body.planId }, { slug: body.planId }] },
    });
    if (!plan) throw new Error('Plan not found');

    const envPlanIds = razorpayPlanIdsFromEnv(plan.slug as PlanSlug);
    const razorpayPlanId =
      billingCycle === 'annual'
        ? plan.razorpayPlanIdAnnual ?? envPlanIds.annual
        : plan.razorpayPlanIdMonthly ?? envPlanIds.monthly;
    const amountPaise =
      billingCycle === 'annual' ? plan.priceAnnualPaise : plan.priceMonthlyPaise;

    if (!amountPaise) {
      throw new Error('This plan is not available for online checkout');
    }

    const hasValidRazorpayPlan = isValidRazorpayPlanId(razorpayPlanId);

    if (config.razorpay.recurringEnabled && hasValidRazorpayPlan) {
      try {
        const workspace = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { email: true, phone: true },
        });

        const customerId = await ensureRazorpayCustomer(workspaceId, this.razorpay);
        const totalCount = billingCycle === 'annual' ? 10 : 120;
        const rzSub = await this.razorpay.createSubscription({
          planId: razorpayPlanId!,
          customerId,
          totalCount,
          customerNotify: 1,
          notifyEmail: workspace?.email ?? undefined,
          notifyPhone: normalizeIndianPhone(workspace?.phone),
          notes: { workspaceId, planId: plan.id, billingCycle },
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
          amountPaise,
          razorpayPlanId: razorpayPlanId!,
        };
      } catch (err) {
        throw normalizeRazorpayError(err);
      }
    }

    if (config.razorpay.recurringEnabled && !hasValidRazorpayPlan) {
      throw new Error(
        `Razorpay plan ID missing for ${plan.slug} (${billingCycle}). Set RAZORPAY_PLAN_${plan.slug.toUpperCase()}_${billingCycle === 'annual' ? 'ANNUAL' : 'MONTHLY'} in .env or run npm run razorpay:sync-plans.`
      );
    }

    return this.createPlanPurchaseOrder(workspaceId, plan, billingCycle, amountPaise);
  }

  private async createPlanPurchaseOrder(
    workspaceId: string,
    plan: { id: string; slug: string; name: string; features: unknown },
    billingCycle: BillingCycle,
    amountPaise: number
  ) {
    const receipt = `plan_${plan.slug}_${Date.now()}`;
    const order = await this.razorpay.createOrder({
      amountPaise,
      receipt,
      notes: {
        workspaceId,
        purpose: 'plan_purchase',
        planId: plan.id,
        billingCycle,
      },
    });

    await prisma.billingInvoice.create({
      data: {
        workspaceId,
        razorpayOrderId: order.id,
        type: 'plan_purchase',
        amountPaise,
        currency: 'INR',
        status: 'created',
        description: `${plan.name} plan (${billingCycle})`,
        metadata: { planId: plan.id, billingCycle } as Prisma.InputJsonValue,
      },
    });

    return {
      checkoutMode: 'order' as const,
      orderId: order.id,
      amountPaise,
      currency: 'INR' as const,
      keyId: this.razorpay.keyId,
      plan: { id: plan.id, name: plan.name, slug: plan.slug },
      billingCycle,
      recurring: false as const,
    };
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
        subscriptionStatus: 'active',
        trialEndsAt: null,
      },
    });

    await this.syncPlanUsageLimits(tx, workspaceId, plan.features as PlanFeatures);
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

    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      throw new Error(`Payment not successful: ${payment.status}`);
    }

    const amountPaise =
      billingSub.billingCycle === 'annual'
        ? billingSub.plan.priceAnnualPaise
        : billingSub.plan.priceMonthlyPaise;

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

      await tx.billingInvoice.create({
        data: {
          workspaceId,
          subscriptionId: billingSub.id,
          razorpayPaymentId: params.razorpay_payment_id,
          type: 'subscription',
          amountPaise: amountPaise ?? payment.amount,
          currency: 'INR',
          status: 'paid',
          paidAt: new Date(),
          description: `${billingSub.plan.name} subscription`,
        },
      });

      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          planId: billingSub.planId,
          subscriptionStatus: 'active',
          trialEndsAt: null,
        },
      });

      await this.syncPlanUsageLimits(tx, workspaceId, billingSub.plan.features as PlanFeatures);
    });

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
    const billingSub = await this.getActiveBillingSubscription(workspaceId);
    if (!billingSub.razorpaySubscriptionId) throw new Error('No Razorpay subscription linked');

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
        data: { subscriptionStatus: 'cancelled' },
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
      data: { subscriptionStatus: 'active' },
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

  async handlePaymentCaptured(payload: Record<string, unknown>) {
    const payment = webhookEntity(payload, 'payment');
    if (!payment?.id) return;

    const orderId = payment.order_id as string | undefined;
    if (!orderId) return;

    const invoice = await prisma.billingInvoice.findFirst({
      where: { razorpayOrderId: orderId },
    });
    if (!invoice || invoice.status === 'paid') return;

    const workspaceId = invoice.workspaceId;
    const paymentId = payment.id as string;

    let paymentCreds: ReturnType<typeof extractPaymentCredentials> | null = null;
    if (invoice.type === 'wallet_topup' /* || invoice.type === 'wallet_auto_recharge_setup' */) {
      const fetchedPayment = await this.razorpay.fetchPayment(paymentId);
      paymentCreds = extractPaymentCredentials(fetchedPayment);
    }

    await prisma.$transaction(async (tx) => {
      await tx.billingInvoice.update({
        where: { id: invoice.id },
        data: {
          razorpayPaymentId: payment.id as string,
          status: 'paid',
          paidAt: new Date(),
        },
      });

      const addon = await tx.billingAddOnPurchase.findFirst({
        where: { workspaceId, razorpayOrderId: orderId },
      });

      if (addon) {
        await tx.billingAddOnPurchase.update({
          where: { id: addon.id },
          data: {
            razorpayPaymentId: payment.id as string,
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
          data: { subscriptionStatus: 'active' },
        });
      }

      if (invoice.type === 'plan_purchase') {
        await this.activatePlanPurchase(tx, workspaceId, invoice.metadata);
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
      if (invoice.type === 'wallet_auto_recharge') {
        await creditWallet({
          workspaceId,
          amountPaise: invoice.amountPaise,
          category: 'wallet_topup',
          description: 'Auto-recharge',
          referenceType: 'invoice',
          referenceId: invoice.id,
          idempotencyKey: `auto-recharge:${invoice.id}`,
          tx,
        });
        await tx.workspaceWallet.update({
          where: { workspaceId },
          data: {
            autoRechargeStatus: 'idle',
            autoRechargeFailCount: 0,
            lastAutoRechargeAt: new Date(),
            autoRechargeCooldownUntil: new Date(Date.now() + AUTO_RECHARGE_COOLDOWN_MS),
          },
        });
      }
      */

      /* AUTO_RECHARGE_DISABLED — re-enable later
      if (invoice.type === 'wallet_auto_recharge_setup') {
        await creditWallet({
          workspaceId,
          amountPaise: invoice.amountPaise,
          category: 'wallet_topup',
          description: 'Payment method setup',
          referenceType: 'invoice',
          referenceId: invoice.id,
          idempotencyKey: `auto-setup:${invoice.id}`,
          tx,
        });
      }
      */
    });

    if (paymentCreds) {
      await saveWalletPaymentCredentials(workspaceId, paymentCreds);
    }
  }

  async handlePaymentFailed(payload: Record<string, unknown>) {
    const payment = webhookEntity(payload, 'payment');
    if (!payment?.order_id) return;

    await prisma.billingInvoice.updateMany({
      where: { razorpayOrderId: payment.order_id as string },
      data: { status: 'failed' },
    });

    await prisma.billingAddOnPurchase.updateMany({
      where: { razorpayOrderId: payment.order_id as string },
      data: { status: 'failed' },
    });
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
        data: { planId: billingSub.planId, subscriptionStatus: 'active', trialEndsAt: null },
      });
      if (billingSub.plan) {
        await this.syncPlanUsageLimits(prisma, workspaceId, billingSub.plan.features as PlanFeatures);
      }
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

    const amountPaise =
      billingSub.billingCycle === 'annual'
        ? billingSub.plan.priceAnnualPaise
        : billingSub.plan.priceMonthlyPaise;

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
          amountPaise: amountPaise ?? (payment.amount as number),
          currency: 'INR',
          status: 'paid',
          paidAt: new Date(),
          description: `${billingSub.plan.name} renewal`,
        },
      });

      await tx.workspace.update({
        where: { id: billingSub.workspaceId },
        data: { subscriptionStatus: 'active', planId: billingSub.planId },
      });
    });
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

  private async getActiveBillingSubscription(workspaceId: string) {
    const billingSub = await prisma.billingSubscription.findFirst({
      where: {
        workspaceId,
        status: { in: ['active', 'authenticated', 'created', 'paused'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!billingSub) throw new Error('No active billing subscription found');
    return billingSub;
  }

  private async addonAmountPaise(type: AddOnType, quantity: number): Promise<number> {
    const entry = ADDON_CATALOG.find((item) => item.type === type);
    if (!entry) throw new Error(`Unknown add-on type: ${type}`);
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
        teamMembersLimit: 2,
        aiAgentsLimit: 1,
        channelsLimit: 2,
        aiTokensIncluded: 0,
        campaignsLimit: 3,
        emailsLimit: 1000,
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

  private parseEmailsLimit(features: PlanFeatures): number {
    const value = features.emailsPerMonth;
    if (value == null) return 1000;
    if (typeof value === 'number') return value;
    if (value === 'unlimited' || value === 'custom') return Number.MAX_SAFE_INTEGER;
    return 1000;
  }

  private async syncPlanUsageLimits(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    features: PlanFeatures
  ) {
    await tx.workspaceUsageLimits.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        contactsLimit: parseFeatureLimit(features.contacts, 1000),
        teamMembersLimit: parseFeatureLimit(features.teamMembers, 2),
        aiAgentsLimit: parseFeatureLimit(features.aiAgents, 1),
        channelsLimit: parseFeatureLimit(features.channels, 2),
        aiTokensIncluded: typeof features.aiReplies === 'number' ? features.aiReplies : 0,
        campaignsLimit:
          typeof features.campaigns === 'number'
            ? features.campaigns
            : features.campaigns === 'unlimited'
              ? Number.MAX_SAFE_INTEGER
              : 3,
        emailsLimit: this.parseEmailsLimit(features),
      },
      update: {
        contactsLimit: parseFeatureLimit(features.contacts, 1000),
        teamMembersLimit: parseFeatureLimit(features.teamMembers, 2),
        aiAgentsLimit: parseFeatureLimit(features.aiAgents, 1),
        channelsLimit: parseFeatureLimit(features.channels, 2),
        aiTokensIncluded: typeof features.aiReplies === 'number' ? features.aiReplies : 0,
        campaignsLimit:
          typeof features.campaigns === 'number'
            ? features.campaigns
            : features.campaigns === 'unlimited'
              ? Number.MAX_SAFE_INTEGER
              : 3,
        emailsLimit: this.parseEmailsLimit(features),
      },
    });
  }
}
