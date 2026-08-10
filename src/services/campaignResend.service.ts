import { prisma } from '../index.js';
import { getEmailService } from '../modules/email/container.js';
import { canResendStatus } from '../lib/messageResendStatus.js';
import { resendFailedMessage } from './messageResend.service.js';

export type CampaignResendResult = {
  messageId: string;
  ok: boolean;
  status?: string;
  error?: string;
};

async function listFailedWhatsAppRecipients(campaignId: string, workspaceId: string) {
  const messages = await prisma.message.findMany({
    where: {
      conversation: { workspaceId },
      metadata: { path: ['campaignId'], equals: campaignId },
      status: 'failed',
    },
    select: { id: true, status: true },
  });
  return messages.filter((m) => canResendStatus(m.status));
}

async function listFailedEmailRecipients(campaignId: string, workspaceId: string) {
  const logs = await prisma.emailLog.findMany({
    where: {
      workspaceId,
      metadata: { path: ['campaignId'], equals: campaignId },
      status: { in: ['failed', 'bounced', 'rejected'] },
    },
    select: { id: true, status: true },
  });
  return logs.filter((l) => canResendStatus(l.status));
}

export async function resendCampaignRecipient(
  campaignId: string,
  workspaceId: string,
  messageId: string,
  channel: 'whatsapp' | 'email' | 'instagram'
): Promise<CampaignResendResult> {
  if (channel === 'email') {
    const log = await prisma.emailLog.findFirst({
      where: {
        id: messageId,
        workspaceId,
        metadata: { path: ['campaignId'], equals: campaignId },
      },
    });
    if (!log) {
      throw Object.assign(new Error('Failed recipient not found'), { statusCode: 404 });
    }
    try {
      const updated = await getEmailService().resendFailedLog(workspaceId, messageId);
      return { messageId, ok: true, status: updated.status };
    } catch (err) {
      return {
        messageId,
        ok: false,
        error: err instanceof Error ? err.message : 'Resend failed',
      };
    }
  }

  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      conversation: { workspaceId },
      metadata: { path: ['campaignId'], equals: campaignId },
    },
    select: { id: true, status: true },
  });
  if (!message) {
    throw Object.assign(new Error('Failed recipient not found'), { statusCode: 404 });
  }

  try {
    const updated = await resendFailedMessage(messageId, workspaceId);
    return { messageId, ok: true, status: updated.status };
  } catch (err) {
    return {
      messageId,
      ok: false,
      error: err instanceof Error ? err.message : 'Resend failed',
    };
  }
}

export async function resendAllCampaignFailed(
  campaignId: string,
  workspaceId: string
): Promise<{ channel: string; total: number; results: CampaignResendResult[] }> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) {
    throw Object.assign(new Error('Campaign not found'), { statusCode: 404 });
  }

  const filter =
    campaign.audienceFilter && typeof campaign.audienceFilter === 'object'
      ? (campaign.audienceFilter as { channel?: string })
      : {};
  const channel = (filter.channel ?? 'whatsapp') as 'whatsapp' | 'email' | 'instagram';

  const ids =
    channel === 'email'
      ? await listFailedEmailRecipients(campaignId, workspaceId)
      : await listFailedWhatsAppRecipients(campaignId, workspaceId);

  const results: CampaignResendResult[] = [];
  for (const row of ids) {
    const result = await resendCampaignRecipient(campaignId, workspaceId, row.id, channel);
    results.push(result);
  }

  return { channel, total: ids.length, results };
}
