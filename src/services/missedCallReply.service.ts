import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage } from './whatsapp.js';
import { recordFlowSend } from './whatsappFlowToken.service.js';
import { assertWhatsAppTemplateAffordable, chargeWhatsAppTemplateUsage } from './walletUsage.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from './templateSendHeader.js';

export type MissedCallSide = 'platform' | 'user';

export type MissedCallReplyFields = {
  missedCallAutoReplyEnabled: boolean;
  missedCallMessage: string | null;
  missedCallTemplateId: string | null;
  userMissedCallAutoReplyEnabled: boolean;
  userMissedCallMessage: string | null;
  userMissedCallTemplateId: string | null;
};

export function missedCallReplyConfig(row: MissedCallReplyFields, side: MissedCallSide) {
  if (side === 'user') {
    return {
      enabled: row.userMissedCallAutoReplyEnabled,
      message: row.userMissedCallMessage,
      templateId: row.userMissedCallTemplateId,
    };
  }
  return {
    enabled: row.missedCallAutoReplyEnabled,
    message: row.missedCallMessage,
    templateId: row.missedCallTemplateId,
  };
}

export function wasDialAnswered(dialStatus: string): boolean {
  const s = dialStatus.toLowerCase();
  return s === 'completed' || s === 'answer' || s === 'answered';
}

/** Callee never picked up — not agent cancel, not a completed talk. */
export function shouldSendUserMissReply(dialStatus: string): boolean {
  const s = dialStatus.toLowerCase();
  return s === 'no-answer' || s === 'busy' || s === 'timeout' || s === 'failed';
}

function bodyParamsForTemplate(variableCount: number, contactName: string | null): string[] {
  if (variableCount <= 0) return [];
  const first = contactName?.trim() || 'there';
  return Array.from({ length: variableCount }, (_, i) => (i === 0 ? first : first));
}

export async function sendMissedCallWhatsApp(input: {
  workspaceId: string;
  toPhone: string;
  message: string | null | undefined;
  templateId: string | null | undefined;
  contactName?: string | null;
}): Promise<void> {
  const to = input.toPhone.replace(/\D/g, '');
  if (!to) return;

  const creds = await getWorkspaceWhatsAppCredentials(input.workspaceId);
  if (!creds.phoneNumberId) return;

  const templateId = input.templateId?.trim() || '';
  if (templateId) {
    const template = await prisma.template.findFirst({
      where: { id: templateId, workspaceId: input.workspaceId },
    });
    if (!template || template.status !== 'approved') return;

    const varCount = Math.max(
      template.variables.length,
      (template.bodyPattern.match(/\{\{\d+\}\}/g) ?? []).length,
    );
    const variables = bodyParamsForTemplate(varCount, input.contactName ?? null);
    let headerMedia:
      | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; waMediaId: string; fileName?: string }
      | undefined;
    if (isTemplateMediaHeaderFormat(template.headerFormat)) {
      headerMedia = await uploadTemplateHeaderMediaForSend(
        creds.accessToken,
        creds.phoneNumberId,
        input.workspaceId,
        template,
      );
    }

    await assertWhatsAppTemplateAffordable({
      workspaceId: input.workspaceId,
      templateCategory: template.category,
      phoneNumberId: creds.phoneNumberId,
    });

    const flowToken = template.buttonType === 'FLOW' ? randomUUID() : undefined;
    const sent = await sendWhatsAppTemplateMessage(
      creds.accessToken,
      creds.phoneNumberId,
      to,
      template.name,
      template.language,
      variables,
      {
        ...(headerMedia ? { headerMedia } : {}),
        ...(flowToken ? { flowToken } : {}),
      },
    );
    if (flowToken && template.buttonFlowId) {
      await recordFlowSend({ flowToken, flowId: template.buttonFlowId, workspaceId: input.workspaceId });
    }
    await chargeWhatsAppTemplateUsage({
      workspaceId: input.workspaceId,
      templateCategory: template.category,
      referenceId: sent.waMessageId || randomUUID(),
      templateName: template.name,
      phoneNumberId: creds.phoneNumberId,
    });
    return;
  }

  const text = input.message?.trim();
  if (!text) return;
  await sendWhatsAppMessage(creds.accessToken, creds.phoneNumberId, to, text);
}
