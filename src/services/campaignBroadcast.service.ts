import { prisma } from '../index.js';
import { getEmailService } from '../modules/email/container.js';
import {
  getCampaignAudienceContacts,
  segmentIdToTag,
  type CampaignAudienceChannel,
} from './campaignAudience.service.js';
import {
  buildCampaignBodyParams,
  emailVariableRequiresManualValue,
  resolveCampaignEmailVariables,
} from './campaignEmailVariables.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { sendWhatsAppTemplateMessage, renderTemplateBody, formatMetaSendError } from './whatsapp.js';
import {
  assertWhatsAppTemplateAffordable,
  chargeWhatsAppTemplateUsage,
} from './walletUsage.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from './templateSendHeader.js';

type CampaignAudienceFilter = {
  channel?: CampaignAudienceChannel;
  segmentId?: string;
  tag?: string;
  variableMappings?: Record<string, string>;
};

function parseAudienceFilter(raw: unknown): CampaignAudienceFilter {
  if (!raw || typeof raw !== 'object') return {};
  return raw as CampaignAudienceFilter;
}

function resolveSegmentId(audienceType: string, filter: CampaignAudienceFilter): string {
  if (audienceType === 'all') return 'all';
  if (filter.segmentId) return filter.segmentId;
  if (filter.tag) return `tag:${filter.tag}`;
  return 'all';
}

async function executeWhatsAppCampaignBroadcast(
  campaignId: string,
  workspaceId: string,
  campaign: { id: string; templateId: string | null; audienceType: string; audienceFilter: unknown }
) {
  const filter = parseAudienceFilter(campaign.audienceFilter);
  if (!campaign.templateId) {
    throw new Error('Campaign has no template');
  }

  const template = await prisma.template.findFirst({
    where: { id: campaign.templateId, workspaceId },
  });
  if (!template) {
    throw new Error('Template not found');
  }
  if (template.status !== 'approved') {
    throw new Error('Only approved templates can be used in campaigns');
  }

  const credentials = await getWorkspaceWhatsAppCredentials(workspaceId);
  if (!credentials.phoneNumberId) {
    throw new Error('No WhatsApp phone number configured for this workspace');
  }

  const segmentId = resolveSegmentId(campaign.audienceType, filter);
  const contacts = await getCampaignAudienceContacts(workspaceId, 'whatsapp', segmentId);
  const mappings = filter.variableMappings ?? {};

  // Preflight: every variable must have a mapping expression (resolved per contact at send).
  if (template.variables.length > 0) {
    const missing = template.variables.filter((name) => !mappings[name]?.trim());
    if (missing.length > 0) {
      throw new Error('All template variables must be filled in before sending');
    }
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalRecipients: contacts.length, status: 'running' },
  });

  let sentCount = 0;
  const errors: string[] = [];

  for (const contact of contacts) {
    try {
      const bodyParams = buildCampaignBodyParams(template.variables, mappings, contact);
      if (bodyParams.some((v) => !v.trim())) {
        errors.push(`${contact.phone}: missing resolved template variable values`);
        continue;
      }

      const displayContent = renderTemplateBody(template.bodyPattern, bodyParams);

      await assertWhatsAppTemplateAffordable({
        workspaceId,
        templateCategory: template.category,
      });

      let headerMedia:
        | {
            format: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
            waMediaId: string;
            fileName?: string;
          }
        | undefined;

      if (isTemplateMediaHeaderFormat(template.headerFormat)) {
        headerMedia = await uploadTemplateHeaderMediaForSend(
          credentials.accessToken,
          credentials.phoneNumberId,
          template
        );
      }

      const sent = await sendWhatsAppTemplateMessage(
        credentials.accessToken,
        credentials.phoneNumberId,
        contact.phone,
        template.name,
        template.language,
        bodyParams,
        headerMedia ? { headerMedia } : undefined
      );

      const { conversation } = await findOrReopenConversationForInbound({
        workspaceId,
        contactId: contact.id,
        channel: 'whatsapp',
        channelAccountId: credentials.phoneNumberId,
      });

      const campaignMessage = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          waMessageId: sent.waMessageId,
          sender: 'agent',
          senderName: 'Campaign',
          content: displayContent,
          type: 'template',
          status: 'sent',
          metadata: {
            campaignId: campaign.id,
            templateId: template.id,
            templateName: template.name,
            variables: bodyParams,
            audienceTag: segmentIdToTag(segmentId),
          },
        },
      });

      await chargeWhatsAppTemplateUsage({
        workspaceId,
        templateCategory: template.category,
        referenceId: campaignMessage.id,
        templateName: template.name,
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessage: displayContent,
          lastMessageAt: new Date(),
        },
      });

      sentCount += 1;
    } catch (err) {
      const msg = formatMetaSendError(err);
      errors.push(`${contact.phone}: ${msg}`);
      console.error('[Campaign] send failed', { campaignId, contactId: contact.id, msg });
    }
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount,
      deliveredCount: sentCount,
      status: sentCount > 0 ? 'completed' : 'failed',
      sentAt: new Date(),
    },
  });

  if (sentCount === 0 && errors.length > 0) {
    throw new Error(errors[0] ?? 'Campaign failed to send to any contact');
  }

  return { sentCount, totalRecipients: contacts.length, errors };
}

async function executeEmailCampaignBroadcast(
  campaignId: string,
  workspaceId: string,
  campaign: { id: string; templateId: string | null; audienceType: string; audienceFilter: unknown }
) {
  const filter = parseAudienceFilter(campaign.audienceFilter);
  if (!campaign.templateId) {
    throw new Error('Campaign has no email template');
  }

  const template = await prisma.emailTemplate.findFirst({
    where: { id: campaign.templateId, workspaceId },
  });
  if (!template) {
    throw new Error('Email template not found');
  }
  if (template.status !== 'active') {
    throw new Error('Only active email templates can be used in campaigns');
  }

  const mappings = filter.variableMappings ?? {};
  const manualVars = template.variables.filter(emailVariableRequiresManualValue);
  if (manualVars.some((v) => !mappings[v]?.trim())) {
    throw new Error('Fill in all campaign-level template variables before sending');
  }

  const segmentId = resolveSegmentId(campaign.audienceType, filter);
  const contacts = await getCampaignAudienceContacts(workspaceId, 'email', segmentId);
  if (contacts.length === 0) {
    throw new Error('No contacts with email addresses in the selected audience');
  }

  const emailService = getEmailService();

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalRecipients: contacts.length, status: 'running' },
  });

  let sentCount = 0;
  const errors: string[] = [];

  for (const contact of contacts) {
    const recipient = contact.email?.trim();
    if (!recipient) continue;

    const variables = resolveCampaignEmailVariables(
      contact,
      mappings,
      template.variables
    );

    if (template.variables.some((v) => !variables[v]?.trim())) {
      errors.push(`${recipient}: missing template variable values`);
      continue;
    }

    try {
      await emailService.sendEmail(workspaceId, {
        to: recipient,
        templateId: template.id,
        variables,
        campaignId: campaign.id,
        contactId: contact.id,
      });
      sentCount += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      errors.push(`${recipient}: ${msg}`);
      console.error('[Campaign] email send failed', { campaignId, contactId: contact.id, msg });
    }
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount,
      deliveredCount: sentCount,
      status: sentCount > 0 ? 'completed' : 'failed',
      sentAt: new Date(),
    },
  });

  if (sentCount === 0 && errors.length > 0) {
    throw new Error(errors[0] ?? 'Campaign failed to send to any contact');
  }

  return { sentCount, totalRecipients: contacts.length, errors };
}

export async function executeCampaignBroadcast(campaignId: string, workspaceId: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  const filter = parseAudienceFilter(campaign.audienceFilter);
  const channel = filter.channel ?? 'whatsapp';

  if (channel === 'whatsapp') {
    return executeWhatsAppCampaignBroadcast(campaignId, workspaceId, campaign);
  }
  if (channel === 'email') {
    return executeEmailCampaignBroadcast(campaignId, workspaceId, campaign);
  }

  throw new Error(`Campaign channel "${channel}" is not supported for sending yet`);
}
