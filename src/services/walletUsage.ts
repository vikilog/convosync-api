import { prisma } from '../index.js';
import { applyAiUsageMarkup, ccToDebitPaise } from './usageCost.constants.js';
import {
  emailSendDebitPaise,
  instagramMessageDebitPaise,
  journeyTriggerDebitPaise,
  whatsAppCategoryDebitPaise,
} from './wallet.constants.js';
import {
  assertWalletBalance,
  debitWallet,
  mapWhatsAppCategoryToDebitCategory,
} from './wallet.service.js';

export async function assertWhatsAppTemplateAffordable(params: {
  workspaceId: string;
  templateCategory: string | null | undefined;
}) {
  const amountPaise = whatsAppCategoryDebitPaise(params.templateCategory);
  if (amountPaise <= 0) return;
  await assertWalletBalance(params.workspaceId, amountPaise);
}

export async function chargeWhatsAppTemplateUsage(params: {
  workspaceId: string;
  templateCategory: string | null | undefined;
  referenceId: string;
  templateName?: string;
}) {
  const amountPaise = whatsAppCategoryDebitPaise(params.templateCategory);
  if (amountPaise <= 0) return;

  await debitWallet({
    workspaceId: params.workspaceId,
    amountPaise,
    category: mapWhatsAppCategoryToDebitCategory(params.templateCategory),
    description: params.templateName
      ? `WhatsApp template · ${params.templateName}`
      : undefined,
    referenceType: 'whatsapp_template',
    referenceId: params.referenceId,
    idempotencyKey: `wa-template:${params.referenceId}`,
  });
}

export async function assertInstagramMessageAffordable(workspaceId: string) {
  const amountPaise = instagramMessageDebitPaise();
  if (amountPaise <= 0) return;
  await assertWalletBalance(workspaceId, amountPaise);
}

export async function chargeInstagramMessageUsage(params: {
  workspaceId: string;
  referenceId: string;
}) {
  const amountPaise = instagramMessageDebitPaise();
  if (amountPaise <= 0) return;

  await debitWallet({
    workspaceId: params.workspaceId,
    amountPaise,
    category: 'instagram',
    referenceType: 'instagram_message',
    referenceId: params.referenceId,
    idempotencyKey: `instagram:${params.referenceId}`,
  });
}

/** Local calendar month — same window as Usage & Cost page billing. */
function billingMonthRange(reference = new Date()) {
  const start = new Date(reference.getFullYear(), reference.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(reference.getFullYear(), reference.getMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
}

export async function assertEmailSendAffordable(workspaceId: string, sendCount = 1) {
  const amountPaise = emailSendDebitPaise(sendCount);
  if (amountPaise <= 0) return;
  await assertWalletBalance(workspaceId, amountPaise);
}

/** 1 email = 1 CC. No free “included” skip — wallet pays for every send. */
export async function chargeEmailSendUsage(params: {
  workspaceId: string;
  referenceId: string;
  sendCount?: number;
}) {
  const sendCount = Math.max(1, Math.round(params.sendCount ?? 1));
  const amountPaise = emailSendDebitPaise(sendCount);
  if (amountPaise <= 0) return;

  await debitWallet({
    workspaceId: params.workspaceId,
    amountPaise,
    category: 'email',
    referenceType: 'email_log',
    referenceId: params.referenceId,
    idempotencyKey: `email:${params.referenceId}`,
  });
}

export async function assertJourneyTriggerAffordable(workspaceId: string) {
  const amountPaise = journeyTriggerDebitPaise();
  if (amountPaise <= 0) return;
  await assertWalletBalance(workspaceId, amountPaise);
}

export async function chargeJourneyTriggerUsage(params: {
  workspaceId: string;
  referenceId: string;
}) {
  const amountPaise = journeyTriggerDebitPaise();
  if (amountPaise <= 0) return;

  await debitWallet({
    workspaceId: params.workspaceId,
    amountPaise,
    category: 'journey_trigger',
    referenceType: 'journey_execution',
    referenceId: params.referenceId,
    idempotencyKey: `journey-trigger:${params.referenceId}`,
  });
}

/**
 * Debit marked-up AI cost for this log row.
 * Markup on month totals matches Usage page; full slice hits wallet (no free included credit).
 */
export async function chargeAiTokenUsage(params: {
  workspaceId: string;
  costInr: number;
  referenceId: string;
  agentId?: string;
}) {
  const rawThis = Math.max(0, params.costInr);
  if (rawThis <= 0) return;

  const { start, end } = billingMonthRange();
  const prior = await prisma.tokenUsageLog.aggregate({
    where: {
      workspaceId: params.workspaceId,
      createdAt: { gte: start, lt: end },
      fromCache: false,
      NOT: { id: params.referenceId },
    },
    _sum: { costInr: true },
  });

  const rawBefore = prior._sum.costInr ?? 0;
  const grossBefore = applyAiUsageMarkup(rawBefore);
  const grossAfter = applyAiUsageMarkup(rawBefore + rawThis);
  const thisGross = Math.round((grossAfter - grossBefore) * 100) / 100;
  const amountPaise = thisGross <= 0 ? 0 : ccToDebitPaise(thisGross);
  if (amountPaise <= 0) return;

  await debitWallet({
    workspaceId: params.workspaceId,
    amountPaise,
    category: 'ai_tokens',
    referenceType: 'token_log',
    referenceId: params.referenceId,
    idempotencyKey: `ai:${params.referenceId}`,
    metadata: params.agentId ? { agentId: params.agentId } : undefined,
  });
}
