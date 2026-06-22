import type { EmailLog } from '@prisma/client';
import { prisma } from '../index.js';
import {
  getCampaignAudienceContacts,
  segmentIdToTag,
  type CampaignAudienceChannel,
} from './campaignAudience.service.js';

type CampaignAudienceFilter = {
  channel?: CampaignAudienceChannel;
  segmentId?: string;
  variableMappings?: Record<string, string>;
};

function parseAudienceFilter(raw: unknown): CampaignAudienceFilter {
  if (!raw || typeof raw !== 'object') return {};
  return raw as CampaignAudienceFilter;
}

function segmentLabelFromFilter(filter: CampaignAudienceFilter): string {
  const segmentId = filter.segmentId ?? 'all';
  if (segmentId === 'all') return 'All contacts';
  const tag = segmentIdToTag(segmentId);
  return tag ? `Tag: ${tag}` : segmentId;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function resolveSegmentId(audienceType: string, filter: CampaignAudienceFilter): string {
  if (audienceType === 'all') return 'all';
  if (filter.segmentId) return filter.segmentId;
  return 'all';
}

/** Primary: metadata.campaignId. Fallback: template + sentAt window (pre-logging campaigns). */
async function findEmailLogsForCampaign(
  campaignId: string,
  workspaceId: string,
  campaign: {
    templateId: string | null;
    sentAt: Date | null;
    sentCount: number;
  }
): Promise<EmailLog[]> {
  const byCampaignId = await prisma.emailLog.findMany({
    where: {
      workspaceId,
      metadata: { path: ['campaignId'], equals: campaignId },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (byCampaignId.length > 0) return byCampaignId;

  if (!campaign.templateId || !campaign.sentAt) return [];

  const sentAt = campaign.sentAt;
  const windowStart = new Date(sentAt.getTime() - 5 * 60 * 1000);
  const windowEnd = new Date(sentAt.getTime() + 15 * 60 * 1000);

  const candidates = await prisma.emailLog.findMany({
    where: {
      workspaceId,
      createdAt: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { createdAt: 'asc' },
  });

  const matched = candidates.filter((log) => {
    const meta = (log.metadata ?? {}) as Record<string, unknown>;
    if (meta.campaignId && meta.campaignId !== campaignId) return false;
    return meta.templateId === campaign.templateId;
  });

  const limit = campaign.sentCount > 0 ? campaign.sentCount : matched.length;
  const result = matched.slice(0, limit);

  await Promise.all(
    result
      .filter((log) => {
        const meta = (log.metadata ?? {}) as Record<string, unknown>;
        return !meta.campaignId;
      })
      .map((log) =>
        prisma.emailLog.update({
          where: { id: log.id },
          data: {
            metadata: {
              ...((log.metadata as Record<string, unknown>) ?? {}),
              campaignId,
              ...(campaign.templateId ? { templateId: campaign.templateId } : {}),
            },
          },
        })
      )
  );

  return result;
}

async function getWhatsAppCampaignInsights(
  campaignId: string,
  workspaceId: string,
  campaign: {
    id: string;
    templateId: string | null;
    totalRecipients: number;
    sentCount: number;
    deliveredCount: number;
    readCount: number;
  }
) {
  const template = campaign.templateId
    ? await prisma.template.findFirst({
        where: { id: campaign.templateId, workspaceId },
        select: {
          id: true,
          name: true,
          category: true,
          language: true,
          bodyPattern: true,
          status: true,
        },
      })
    : null;

  const messages = await prisma.message.findMany({
    where: {
      conversation: { workspaceId },
      metadata: {
        path: ['campaignId'],
        equals: campaignId,
      },
    },
    include: {
      conversation: {
        include: {
          contact: {
            select: { id: true, name: true, phone: true, email: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const statusCounts = {
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    pending: 0,
  };

  for (const msg of messages) {
    const s = msg.status.toLowerCase();
    if (s === 'read') statusCounts.read += 1;
    else if (s === 'delivered') statusCounts.delivered += 1;
    else if (s === 'failed') statusCounts.failed += 1;
    else if (s === 'sent') statusCounts.sent += 1;
    else statusCounts.pending += 1;
  }

  const sentTotal = messages.length || campaign.sentCount;
  const deliveredTotal = statusCounts.delivered + statusCounts.read;
  const readTotal = statusCounts.read;

  const insights = {
    totalRecipients: campaign.totalRecipients,
    sent: sentTotal,
    delivered: Math.max(campaign.deliveredCount, deliveredTotal),
    read: Math.max(campaign.readCount, readTotal),
    failed: statusCounts.failed,
    pending: statusCounts.pending + statusCounts.sent,
    deliveryRate: rate(Math.max(campaign.deliveredCount, deliveredTotal), sentTotal || campaign.totalRecipients),
    readRate: rate(Math.max(campaign.readCount, readTotal), sentTotal || campaign.totalRecipients),
    opened: 0,
    openRate: 0,
  };

  const recipients = messages.map((msg) => ({
    messageId: msg.id,
    conversationId: msg.conversationId,
    contactId: msg.conversation.contact.id,
    contactName: msg.conversation.contact.name,
    phone: msg.conversation.contact.phone,
    email: msg.conversation.contact.email,
    status: msg.status,
    sentAt: msg.createdAt.toISOString(),
    content: msg.content,
    errorMessage: null as string | null,
  }));

  return { template, insights, recipients, variableMappings: {} as Record<string, string> };
}

async function getEmailCampaignInsights(
  campaignId: string,
  workspaceId: string,
  campaign: {
    id: string;
    templateId: string | null;
    totalRecipients: number;
    sentCount: number;
    deliveredCount: number;
    sentAt: Date | null;
    audienceType: string;
    audienceFilter: unknown;
  }
) {
  const filter = parseAudienceFilter(campaign.audienceFilter);
  const variableMappings = filter.variableMappings ?? {};

  const template = campaign.templateId
    ? await prisma.emailTemplate.findFirst({
        where: { id: campaign.templateId, workspaceId },
        select: {
          id: true,
          name: true,
          subject: true,
          htmlBody: true,
          textBody: true,
          status: true,
          variables: true,
        },
      })
    : null;

  let emailLogs = await findEmailLogsForCampaign(campaignId, workspaceId, campaign);

  const contactIds = new Set<string>();
  const recipientEmails = new Set<string>();
  for (const log of emailLogs) {
    const meta = log.metadata as { contactId?: string } | null;
    if (meta?.contactId) contactIds.add(meta.contactId);
    if (log.recipient) recipientEmails.add(log.recipient.toLowerCase());
  }

  const contactsById = new Map<string, { id: string; name: string; phone: string; email: string | null }>();
  const contactsByEmail = new Map<string, { id: string; name: string; phone: string; email: string | null }>();

  const contactQueries: Promise<void>[] = [];
  if (contactIds.size > 0) {
    contactQueries.push(
      prisma.contact
        .findMany({
          where: { workspaceId, id: { in: [...contactIds] } },
          select: { id: true, name: true, phone: true, email: true },
        })
        .then((contacts) => {
          for (const c of contacts) {
            contactsById.set(c.id, c);
            if (c.email) contactsByEmail.set(c.email.toLowerCase(), c);
          }
        })
    );
  }
  if (recipientEmails.size > 0) {
    contactQueries.push(
      prisma.contact
        .findMany({
          where: {
            workspaceId,
            email: { in: [...recipientEmails], mode: 'insensitive' },
          },
          select: { id: true, name: true, phone: true, email: true },
        })
        .then((contacts) => {
          for (const c of contacts) {
            contactsById.set(c.id, c);
            if (c.email) contactsByEmail.set(c.email.toLowerCase(), c);
          }
        })
    );
  }
  await Promise.all(contactQueries);

  let sent = 0;
  let delivered = 0;
  let opened = 0;
  let failed = 0;
  let pending = 0;

  let recipients = emailLogs.map((log) => {
    const meta = log.metadata as { contactId?: string } | null;
    const contact =
      (meta?.contactId ? contactsById.get(meta.contactId) : undefined) ??
      contactsByEmail.get(log.recipient.toLowerCase());
    const status = log.status.toLowerCase();

    if (status === 'failed' || status === 'bounced') failed += 1;
    else if (status === 'opened' || status === 'clicked') {
      opened += 1;
      delivered += 1;
      sent += 1;
    } else if (status === 'delivered') {
      delivered += 1;
      sent += 1;
    } else if (status === 'sent') sent += 1;
    else if (status === 'queued') pending += 1;
    else sent += 1;

    return {
      messageId: log.id,
      conversationId: '',
      contactId: contact?.id ?? meta?.contactId ?? '',
      contactName: contact?.name ?? log.recipient,
      phone: contact?.phone ?? '',
      email: log.recipient,
      status: log.status,
      sentAt: log.createdAt.toISOString(),
      content: log.subject,
      errorMessage: log.errorMessage,
    };
  });

  if (recipients.length === 0 && campaign.sentCount > 0) {
    const segmentId = resolveSegmentId(campaign.audienceType, filter);
    const audienceContacts = await getCampaignAudienceContacts(workspaceId, 'email', segmentId);
    const sentAtIso = campaign.sentAt?.toISOString() ?? new Date().toISOString();
    recipients = audienceContacts.slice(0, campaign.sentCount).map((contact) => ({
      messageId: `campaign-${campaignId}-${contact.id}`,
      conversationId: '',
      contactId: contact.id,
      contactName: contact.name,
      phone: contact.phone,
      email: contact.email,
      status: 'sent',
      sentAt: sentAtIso,
      content: template?.subject ?? '',
      errorMessage: null as string | null,
    }));
    emailLogs = [];
  }

  const sentTotal = recipients.length || emailLogs.length || campaign.sentCount;
  const deliveredTotal = Math.max(campaign.deliveredCount, delivered);
  const openedTotal = opened;

  const insights = {
    totalRecipients: campaign.totalRecipients,
    sent: sentTotal,
    delivered: deliveredTotal,
    read: openedTotal,
    failed,
    pending,
    deliveryRate: rate(deliveredTotal, sentTotal || campaign.totalRecipients),
    readRate: rate(openedTotal, sentTotal || campaign.totalRecipients),
    opened: openedTotal,
    openRate: rate(openedTotal, sentTotal || campaign.totalRecipients),
  };

  return {
    template: template
      ? {
          id: template.id,
          name: template.name,
          subject: template.subject,
          htmlBody: template.htmlBody,
          textBody: template.textBody,
          status: template.status,
          variables: template.variables,
        }
      : null,
    insights,
    recipients,
    variableMappings,
  };
}

export async function getCampaignInsights(campaignId: string, workspaceId: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) {
    return null;
  }

  const filter = parseAudienceFilter(campaign.audienceFilter);
  const channel = filter.channel ?? 'whatsapp';

  const channelInsights =
    channel === 'email'
      ? await getEmailCampaignInsights(campaignId, workspaceId, campaign)
      : await getWhatsAppCampaignInsights(campaignId, workspaceId, campaign);

  return {
    campaign,
    channel,
    segmentLabel: segmentLabelFromFilter(filter),
    template: channelInsights.template,
    insights: channelInsights.insights,
    recipients: channelInsights.recipients,
    variableMappings: channelInsights.variableMappings,
  };
}
