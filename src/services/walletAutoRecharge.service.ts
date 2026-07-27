import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import Razorpay from 'razorpay';
import type { FastifyInstance } from 'fastify';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import {
  AUTO_RECHARGE_COOLDOWN_MS,
  DEFAULT_AUTO_RECHARGE_AMOUNT_PAISE,
  MAX_AUTO_RECHARGE_FAILS,
  MIN_WALLET_TOPUP_PAISE,
} from './wallet.constants.js';
import { creditWallet, ensureWallet } from './wallet.service.js';
import {
  ensureRazorpayCustomer,
  extractPaymentCredentials,
  getWorkspaceRazorpayContact,
  saveWalletPaymentCredentials,
} from './razorpayCustomer.service.js';
import { getWalletAutoRechargeQueue } from '../queue/wallet-auto-recharge.queue.js';
import {
  isRazorpayFeatureNotEnabledError,
  razorpayRecurringNotEnabledMessage,
} from '../utils/razorpay-error.utils.js';

function createRazorpayService(): RazorpayService {
  const client = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  return new RazorpayService({ razorpay: client } as FastifyInstance);
}

export async function scheduleWalletAutoRecharge(workspaceId: string): Promise<void> {
  if (!config.razorpay.enabled) return;

  const wallet = await prisma.workspaceWallet.findUnique({ where: { workspaceId } });
  if (!wallet?.autoRechargeEnabled) return;
  if (!wallet.razorpayTokenId) return;
  if (wallet.balancePaise > wallet.lowBalanceThresholdPaise) return;
  if (wallet.autoRechargeStatus === 'charging') return;
  if (wallet.autoRechargeCooldownUntil && wallet.autoRechargeCooldownUntil > new Date()) return;
  if (wallet.autoRechargeFailCount >= MAX_AUTO_RECHARGE_FAILS) return;

  await getWalletAutoRechargeQueue().add(
    'charge',
    { workspaceId },
    {
      // BullMQ custom jobId cannot contain `:`.
      jobId: `wallet-auto-recharge-${workspaceId}`,
      removeOnComplete: true,
    }
  );
}

export async function processWalletAutoRecharge(workspaceId: string): Promise<void> {
  if (!config.razorpay.enabled) return;

  const razorpay = createRazorpayService();
  const wallet = await ensureWallet(workspaceId);

  if (!wallet.autoRechargeEnabled || !wallet.razorpayTokenId) return;
  if (wallet.balancePaise > wallet.lowBalanceThresholdPaise) return;
  if (wallet.autoRechargeStatus === 'charging') return;
  if (wallet.autoRechargeCooldownUntil && wallet.autoRechargeCooldownUntil > new Date()) return;
  if (wallet.autoRechargeFailCount >= MAX_AUTO_RECHARGE_FAILS) {
    await prisma.workspaceWallet.update({
      where: { workspaceId },
      data: { autoRechargeEnabled: false, autoRechargeStatus: 'failed' },
    });
    return;
  }

  const amountPaise = Math.max(
    MIN_WALLET_TOPUP_PAISE,
    wallet.autoRechargeAmountPaise || DEFAULT_AUTO_RECHARGE_AMOUNT_PAISE
  );

  const lock = await prisma.workspaceWallet.updateMany({
    where: {
      workspaceId,
      autoRechargeStatus: { not: 'charging' },
    },
    data: { autoRechargeStatus: 'charging' },
  });
  if (lock.count === 0) return;

  try {
    const contact = await getWorkspaceRazorpayContact(workspaceId);
    const customerId = await ensureRazorpayCustomer(workspaceId, razorpay);

    const order = await razorpay.createOrder({
      amountPaise,
      receipt: `auto_${workspaceId.slice(-8)}_${Date.now()}`,
      paymentCapture: true,
      notes: {
        workspaceId,
        purpose: 'wallet_auto_recharge',
      },
    });

    const invoice = await prisma.billingInvoice.create({
      data: {
        workspaceId,
        razorpayOrderId: order.id,
        type: 'wallet_auto_recharge',
        amountPaise,
        currency: 'INR',
        status: 'created',
        description: 'ConvoCoins auto-recharge',
        metadata: { purpose: 'wallet_auto_recharge' },
      },
    });

    const payment = await razorpay.chargeWithToken({
      amountPaise,
      orderId: order.id,
      customerId,
      tokenId: wallet.razorpayTokenId,
      email: contact.email,
      contact: contact.phone,
      description: 'ConvoCoins auto-recharge',
    });

    const creds = extractPaymentCredentials(payment);
    await saveWalletPaymentCredentials(workspaceId, creds);

    if (payment.status === 'captured' || payment.status === 'authorized') {
      await prisma.$transaction(async (tx) => {
        await tx.billingInvoice.update({
          where: { id: invoice.id },
          data: {
            razorpayPaymentId: payment.id,
            status: 'paid',
            paidAt: new Date(),
          },
        });

        await creditWallet({
          workspaceId,
          amountPaise,
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
      });
      return;
    }

    throw new Error(`Auto-recharge payment not captured: ${payment.status}`);
  } catch (err) {
    if (isRazorpayFeatureNotEnabledError(err)) {
      await prisma.workspaceWallet.update({
        where: { workspaceId },
        data: { autoRechargeStatus: 'config_required' },
      });
      throw new Error(razorpayRecurringNotEnabledMessage());
    }

    const failCount = wallet.autoRechargeFailCount + 1;
    await prisma.workspaceWallet.update({
      where: { workspaceId },
      data: {
        autoRechargeStatus: failCount >= MAX_AUTO_RECHARGE_FAILS ? 'failed' : 'idle',
        autoRechargeFailCount: failCount,
        autoRechargeEnabled: failCount >= MAX_AUTO_RECHARGE_FAILS ? false : wallet.autoRechargeEnabled,
        autoRechargeCooldownUntil: new Date(Date.now() + AUTO_RECHARGE_COOLDOWN_MS),
      },
    });
    throw err;
  }
}

export async function scanLowBalanceAutoRechargeWallets(): Promise<void> {
  const wallets = await prisma.workspaceWallet.findMany({
    where: {
      autoRechargeEnabled: true,
      razorpayTokenId: { not: null },
      autoRechargeFailCount: { lt: MAX_AUTO_RECHARGE_FAILS },
    },
    select: { workspaceId: true, balancePaise: true, lowBalanceThresholdPaise: true },
  });

  for (const wallet of wallets) {
    if (wallet.balancePaise <= wallet.lowBalanceThresholdPaise) {
      await scheduleWalletAutoRecharge(wallet.workspaceId);
    }
  }
}

export async function completeWalletAutoRechargeFromWebhook(
  workspaceId: string,
  invoiceId: string,
  paymentId: string,
  amountPaise: number
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.billingInvoice.findFirst({
      where: { id: invoiceId, workspaceId, type: 'wallet_auto_recharge' },
    });
    if (!invoice || invoice.status === 'paid') return;

    await tx.billingInvoice.update({
      where: { id: invoice.id },
      data: {
        razorpayPaymentId: paymentId,
        status: 'paid',
        paidAt: new Date(),
      },
    });

    await creditWallet({
      workspaceId,
      amountPaise,
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
  });
}
