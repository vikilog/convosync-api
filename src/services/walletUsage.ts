import {
  aiUsageDebitPaise,
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

export async function assertEmailSendAffordable(workspaceId: string, sendCount = 1) {
  const amountPaise = emailSendDebitPaise(sendCount);
  if (amountPaise <= 0) return;
  await assertWalletBalance(workspaceId, amountPaise);
}

export async function chargeEmailSendUsage(params: {
  workspaceId: string;
  referenceId: string;
  sendCount?: number;
}) {
  const amountPaise = emailSendDebitPaise(params.sendCount ?? 1);
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

export async function chargeAiTokenUsage(params: {
  workspaceId: string;
  costInr: number;
  referenceId: string;
  agentId?: string;
}) {
  const amountPaise = aiUsageDebitPaise(params.costInr);
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
