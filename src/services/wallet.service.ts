import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  DEFAULT_LOW_BALANCE_THRESHOLD_PAISE,
  MIN_WALLET_TOPUP_PAISE,
  SIGNUP_WALLET_CREDIT_PAISE,
  type WalletCreditCategory,
  type WalletDebitCategory,
  walletDebitCategoryLabel,
} from './wallet.constants.js';
import { ccToDebitPaise } from './usageCost.constants.js';
import { parsePlanWalletCreditsCc, type PlanFeatures } from './subscriptionPlans.js';
// import { scheduleWalletAutoRecharge } from './walletAutoRecharge.service.js';

type TxClient = Prisma.TransactionClient;

export class InsufficientWalletBalanceError extends Error {
  readonly code = 'INSUFFICIENT_WALLET_BALANCE';

  constructor(
    public readonly balancePaise: number,
    public readonly requiredPaise: number
  ) {
    super(
      `Insufficient wallet balance. Need ₹${(requiredPaise / 100).toFixed(2)}, available ₹${(balancePaise / 100).toFixed(2)}.`
    );
    this.name = 'InsufficientWalletBalanceError';
  }
}

export async function ensureWallet(workspaceId: string, tx?: TxClient) {
  const db = tx ?? prisma;
  return db.workspaceWallet.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      balancePaise: 0,
      lowBalanceThresholdPaise: DEFAULT_LOW_BALANCE_THRESHOLD_PAISE,
    },
    update: {},
  });
}

export type PlanWalletCreditSource =
  | 'plan_purchase'
  | 'subscription_payment'
  | 'subscription_renewal';

/** Monthly CC from plan features → paise for the billing period (×12 on annual). */
export function planIncludedCreditPaise(
  features: PlanFeatures,
  billingCycle: 'monthly' | 'annual' = 'monthly'
): number {
  const monthlyCc = parsePlanWalletCreditsCc(features.walletCredits);
  if (monthlyCc == null || monthlyCc <= 0) return 0;
  const multiplier = billingCycle === 'annual' ? 12 : 1;
  return ccToDebitPaise(monthlyCc * multiplier);
}

/** Idempotent plan-included CC credit (payment id or invoice id as externalId). */
export async function creditPlanWalletCredits(params: {
  workspaceId: string;
  plan: { name: string; features: PlanFeatures };
  billingCycle?: 'monthly' | 'annual';
  source: PlanWalletCreditSource;
  externalId: string;
  tx?: TxClient;
}) {
  const billingCycle = params.billingCycle ?? 'monthly';
  const amountPaise = planIncludedCreditPaise(params.plan.features, billingCycle);
  if (amountPaise <= 0) return null;

  const monthlyCc = parsePlanWalletCreditsCc(params.plan.features.walletCredits) ?? 0;
  const ccTotal = billingCycle === 'annual' ? monthlyCc * 12 : monthlyCc;

  return creditWallet({
    workspaceId: params.workspaceId,
    amountPaise,
    category: 'adjustment',
    description: `Plan included ConvoCoins — ${params.plan.name} (${ccTotal} CC)`,
    referenceType: params.source,
    referenceId: params.externalId,
    idempotencyKey: `plan-wallet:${params.externalId}`,
    tx: params.tx,
  });
}

/** Idempotent welcome credit for new customer workspaces. */
export async function grantSignupWalletCredit(workspaceId: string, tx?: TxClient) {
  return creditWallet({
    workspaceId,
    amountPaise: SIGNUP_WALLET_CREDIT_PAISE,
    category: 'adjustment',
    description: 'Welcome credit — 100 ConvoCoins',
    referenceType: 'signup',
    referenceId: workspaceId,
    idempotencyKey: `signup-wallet-credit:${workspaceId}`,
    tx,
  });
}

export async function getWalletMonthSpentPaise(workspaceId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const result = await prisma.walletTransaction.aggregate({
    where: {
      workspaceId,
      type: 'debit',
      createdAt: { gte: startOfMonth },
    },
    _sum: { amountPaise: true },
  });
  return result._sum.amountPaise ?? 0;
}

export async function getWalletSummary(workspaceId: string) {
  const wallet = await ensureWallet(workspaceId);
  const monthSpentPaise = await getWalletMonthSpentPaise(workspaceId);
  const isLowBalance = wallet.balancePaise <= wallet.lowBalanceThresholdPaise;
  return {
    balancePaise: wallet.balancePaise,
    balanceInr: wallet.balancePaise / 100,
    lowBalanceThresholdPaise: wallet.lowBalanceThresholdPaise,
    lowBalanceThresholdInr: wallet.lowBalanceThresholdPaise / 100,
    isLowBalance,
    lowBalanceAlertAt: wallet.lowBalanceAlertAt?.toISOString() ?? null,
    autoRechargeEnabled: wallet.autoRechargeEnabled,
    autoRechargeAmountPaise: wallet.autoRechargeAmountPaise,
    autoRechargeAmountInr: wallet.autoRechargeAmountPaise / 100,
    hasPaymentMethod: Boolean(wallet.razorpayTokenId),
    autoRechargeStatus: wallet.autoRechargeStatus,
    lastAutoRechargeAt: wallet.lastAutoRechargeAt?.toISOString() ?? null,
    monthSpentPaise,
    monthSpentInr: monthSpentPaise / 100,
  };
}

export async function updateWalletSettings(
  workspaceId: string,
  params: {
    lowBalanceThresholdPaise?: number;
    autoRechargeEnabled?: boolean;
    autoRechargeAmountPaise?: number;
  }
) {
  await ensureWallet(workspaceId);

  if (
    params.lowBalanceThresholdPaise !== undefined &&
    (params.lowBalanceThresholdPaise < 1000 || params.lowBalanceThresholdPaise > 1_000_000)
  ) {
    throw new Error('Low balance alert must be between ₹10 and ₹10,000.');
  }

  /* AUTO_RECHARGE_DISABLED — re-enable later
  if (
    params.autoRechargeAmountPaise !== undefined &&
    (params.autoRechargeAmountPaise < MIN_WALLET_TOPUP_PAISE ||
      params.autoRechargeAmountPaise > 1_000_000)
  ) {
    throw new Error('Auto-recharge amount must be between 100 CC and 10,000 CC.');
  }

  if (params.autoRechargeEnabled === true) {
    const current = await prisma.workspaceWallet.findUnique({ where: { workspaceId } });
    if (!current?.razorpayTokenId) {
      throw new Error('Save a payment method before enabling auto-recharge.');
    }
  }
  */

  const wallet = await prisma.workspaceWallet.update({
    where: { workspaceId },
    data: {
      ...(params.lowBalanceThresholdPaise !== undefined
        ? { lowBalanceThresholdPaise: params.lowBalanceThresholdPaise }
        : {}),
      /* AUTO_RECHARGE_DISABLED — re-enable later
      ...(params.autoRechargeEnabled !== undefined
        ? {
            autoRechargeEnabled: params.autoRechargeEnabled,
            ...(params.autoRechargeEnabled
              ? { autoRechargeStatus: 'idle', autoRechargeFailCount: 0 }
              : {}),
          }
        : {}),
      ...(params.autoRechargeAmountPaise !== undefined
        ? { autoRechargeAmountPaise: params.autoRechargeAmountPaise }
        : {}),
      */
    },
  });

  return getWalletSummary(workspaceId).then((summary) => ({
    ...summary,
    balancePaise: wallet.balancePaise,
    balanceInr: wallet.balancePaise / 100,
  }));
}

export async function assertWalletBalance(
  workspaceId: string,
  requiredPaise: number
): Promise<void> {
  if (requiredPaise <= 0) return;
  const wallet = await ensureWallet(workspaceId);
  if (wallet.balancePaise < requiredPaise) {
    throw new InsufficientWalletBalanceError(wallet.balancePaise, requiredPaise);
  }
}

type CreditParams = {
  workspaceId: string;
  amountPaise: number;
  category: WalletCreditCategory;
  description?: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  metadata?: Prisma.InputJsonValue;
  tx?: TxClient;
};

export async function creditWallet(params: CreditParams) {
  const {
    workspaceId,
    amountPaise,
    category,
    description,
    referenceType,
    referenceId,
    idempotencyKey,
    metadata,
    tx,
  } = params;

  if (amountPaise <= 0) throw new Error('Credit amount must be positive');

  const run = async (client: TxClient) => {
    if (idempotencyKey) {
      const existing = await client.walletTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        const wallet = await client.workspaceWallet.findUniqueOrThrow({
          where: { workspaceId },
        });
        return { transaction: existing, wallet };
      }
    }

    await ensureWallet(workspaceId, client);
    const wallet = await client.workspaceWallet.update({
      where: { workspaceId },
      data: { balancePaise: { increment: amountPaise } },
    });

    const transaction = await client.walletTransaction.create({
      data: {
        workspaceId,
        type: 'credit',
        category,
        amountPaise,
        balanceAfterPaise: wallet.balancePaise,
        description: description ?? walletDebitCategoryLabel(category),
        referenceType,
        referenceId,
        idempotencyKey,
        metadata,
      },
    });

    if (wallet.balancePaise > wallet.lowBalanceThresholdPaise) {
      await client.workspaceWallet.update({
        where: { workspaceId },
        data: { lowBalanceAlertAt: null },
      });
    }

    return { transaction, wallet };
  };

  if (tx) return run(tx);
  return prisma.$transaction(run);
}

type DebitParams = {
  workspaceId: string;
  amountPaise: number;
  category: WalletDebitCategory;
  description?: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  metadata?: Prisma.InputJsonValue;
  tx?: TxClient;
};

export async function debitWallet(params: DebitParams) {
  const {
    workspaceId,
    amountPaise,
    category,
    description,
    referenceType,
    referenceId,
    idempotencyKey,
    metadata,
    tx,
  } = params;

  if (amountPaise <= 0) return null;

  const run = async (client: TxClient) => {
    if (idempotencyKey) {
      const existing = await client.walletTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return { transaction: existing, lowBalanceTriggered: false, balancePaise: existing.balanceAfterPaise };
      }
    }

    await ensureWallet(workspaceId, client);

    // Compare-and-swap: the balance check lives in the WHERE clause of the
    // same UPDATE, not a separate preceding read — two concurrent debits
    // racing a low balance could otherwise both pass a stale read's check
    // before either commits, driving the balance negative past either
    // individual check. If this affects 0 rows, re-read just for the error
    // message (the common, successful path never pays that extra query).
    const debited = await client.workspaceWallet.updateMany({
      where: { workspaceId, balancePaise: { gte: amountPaise } },
      data: { balancePaise: { decrement: amountPaise } },
    });
    if (debited.count === 0) {
      const current = await ensureWallet(workspaceId, client);
      throw new InsufficientWalletBalanceError(current.balancePaise, amountPaise);
    }
    const updated = await client.workspaceWallet.findUniqueOrThrow({
      where: { workspaceId },
    });

    const transaction = await client.walletTransaction.create({
      data: {
        workspaceId,
        type: 'debit',
        category,
        amountPaise,
        balanceAfterPaise: updated.balancePaise,
        description: description ?? walletDebitCategoryLabel(category),
        referenceType,
        referenceId,
        idempotencyKey,
        metadata,
      },
    });

    let lowBalanceTriggered = false;
    if (
      updated.balancePaise <= updated.lowBalanceThresholdPaise &&
      !updated.lowBalanceAlertAt
    ) {
      await client.workspaceWallet.update({
        where: { workspaceId },
        data: { lowBalanceAlertAt: new Date() },
      });
      lowBalanceTriggered = true;
    }

    return { transaction, lowBalanceTriggered, balancePaise: updated.balancePaise };
  };

  if (tx) {
    const nested = await run(tx);
    return nested.transaction;
  }
  const result = await prisma.$transaction(run);
  if (result.lowBalanceTriggered) {
    const balanceCc = (result.balancePaise / 100).toFixed(2);
    void import('./notifications/emitNotification.js').then(({ emitNotification }) =>
      import('./notifications/types.js').then(({ NOTIFICATION_TYPES }) =>
        emitNotification({
          workspaceId,
          type: NOTIFICATION_TYPES.WALLET_BALANCE_LOW,
          title: 'Wallet balance low',
          message: `Wallet balance is ${balanceCc} CC — top up to keep sending.`,
          entityType: 'wallet',
          entityId: workspaceId,
          metadata: { balancePaise: result.balancePaise },
        })
      )
    );
  }
  // AUTO_RECHARGE_DISABLED — re-enable later
  // void scheduleWalletAutoRecharge(workspaceId).catch(() => undefined);
  return result.transaction;
}

export async function listWalletTransactions(workspaceId: string, limit = 50) {
  await ensureWallet(workspaceId);
  const rows = await prisma.walletTransaction.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    category: row.category,
    categoryLabel: walletDebitCategoryLabel(row.category),
    amountPaise: row.amountPaise,
    amountInr: row.amountPaise / 100,
    balanceAfterPaise: row.balanceAfterPaise,
    balanceAfterInr: row.balanceAfterPaise / 100,
    description: row.description,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export function mapWhatsAppCategoryToDebitCategory(
  category: string | null | undefined
): WalletDebitCategory {
  const normalized = (category ?? 'marketing').toLowerCase();
  if (normalized === 'utility') return 'whatsapp_utility';
  if (normalized === 'authentication' || normalized === 'auth') {
    return 'whatsapp_authentication';
  }
  if (normalized === 'service') return 'whatsapp_service';
  return 'whatsapp_marketing';
}
