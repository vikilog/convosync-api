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
      if (existing) return existing;
    }

    const wallet = await ensureWallet(workspaceId, client);
    if (wallet.balancePaise < amountPaise) {
      throw new InsufficientWalletBalanceError(wallet.balancePaise, amountPaise);
    }

    const updated = await client.workspaceWallet.update({
      where: { workspaceId },
      data: { balancePaise: { decrement: amountPaise } },
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

    if (
      updated.balancePaise <= updated.lowBalanceThresholdPaise &&
      !updated.lowBalanceAlertAt
    ) {
      await client.workspaceWallet.update({
        where: { workspaceId },
        data: { lowBalanceAlertAt: new Date() },
      });
    }

    return transaction;
  };

  if (tx) return run(tx);
  const result = await prisma.$transaction(run);
  // AUTO_RECHARGE_DISABLED — re-enable later
  // void scheduleWalletAutoRecharge(workspaceId).catch(() => undefined);
  return result;
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
