import { prisma } from '../index.js';
import { getEmailService } from '../modules/email/container.js';
import {
  audienceTagFromIds,
  getCampaignAudienceContacts,
  resolveSegmentIdsFromFilter,
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
  hasCampaignHeaderMediaSource,
  parseCampaignHeaderMediaOverride,
} from './campaignHeaderMedia.js';
import { readMediaGalleryFile } from '../modules/media-gallery/media-storage.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from './templateSendHeader.js';

type CampaignAudienceFilter = {
  channel?: CampaignAudienceChannel;
  segmentId?: string;
  segmentIds?: string[];
  tag?: string;
  variableMappings?: Record<string, string>;
  headerMediaStorageKey?: string;
  headerMediaMimeType?: string;
  headerMediaFileName?: string;
  headerMediaAssetId?: string;
};

function parseAudienceFilter(raw: unknown): CampaignAudienceFilter {
  if (!raw || typeof raw !== 'object') return {};
  return raw as CampaignAudienceFilter;
}

async function emitCampaignFinishedNotification(input: {
  workspaceId: string;
  campaignId: string;
  campaignName: string;
  status: 'completed' | 'failed';
  sentCount: number;
  totalRecipients: number;
}) {
  const { NOTIFICATION_TYPES } = await import('./notifications/types.js');
  const { emitNotification } = await import('./notifications/emitNotification.js');
  const ok = input.status === 'completed';
  await emitNotification({
    workspaceId: input.workspaceId,
    type: ok ? NOTIFICATION_TYPES.CAMPAIGN_COMPLETED : NOTIFICATION_TYPES.CAMPAIGN_FAILED,
    title: ok ? 'Campaign completed' : 'Campaign failed',
    message: ok
      ? `${input.campaignName} finished — ${input.sentCount}/${input.totalRecipients} sent.`
      : `${input.campaignName} failed to send.`,
    entityType: 'campaign',
    entityId: input.campaignId,
    metadata: {
      sentCount: input.sentCount,
      totalRecipients: input.totalRecipients,
      status: input.status,
    },
  });
}

async function executeWhatsAppCampaignBroadcast(
  campaignId: string,
  workspaceId: string,
  campaign: {
    id: string;
    name: string;
    templateId: string | null;
    audienceType: string;
    audienceFilter: unknown;
  }
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

  const segmentIds = resolveSegmentIdsFromFilter(campaign.audienceType, filter);
  const audienceTag = audienceTagFromIds(segmentIds);
  const contacts = await getCampaignAudienceContacts(workspaceId, 'whatsapp', segmentIds);
  const mappings = filter.variableMappings ?? {};

  // Preflight: every variable must have a mapping expression (resolved per contact at send).
  if (template.variables.length > 0) {
    const missing = template.variables.filter((name) => !mappings[name]?.trim());
    if (missing.length > 0) {
      throw new Error('All template variables must be filled in before sending');
    }
  }

  const mediaOverride = parseCampaignHeaderMediaOverride(filter);
  if (
    isTemplateMediaHeaderFormat(template.headerFormat) &&
    !hasCampaignHeaderMediaSource(mediaOverride, template.headerMediaStorageKey)
  ) {
    throw new Error(
      'This template requires header media. Select an image, video, or document before launching the campaign.'
    );
  }

  // Same media header for every recipient — resolve + upload once before marking running.
  let headerMedia:
    | {
        format: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
        waMediaId: string;
        fileName?: string;
      }
    | undefined;
  if (isTemplateMediaHeaderFormat(template.headerFormat)) {
    let uploaded:
      | { buffer: Buffer; mimeType: string; fileName?: string }
      | null = null;
    let mediaRecord = template;

    if (mediaOverride.headerMediaAssetId) {
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: mediaOverride.headerMediaAssetId,
          workspaceId,
          isActive: true,
        },
      });
      if (!asset?.storageKey) {
        throw new Error('Selected gallery media was not found or has no stored file');
      }
      const file = await readMediaGalleryFile(asset.storageKey);
      uploaded = {
        buffer: file.buffer,
        mimeType: asset.mimeType || file.mimeType,
        fileName: mediaOverride.headerMediaFileName || asset.filename || undefined,
      };
    } else if (mediaOverride.headerMediaStorageKey) {
      mediaRecord = {
        ...template,
        headerMediaStorageKey: mediaOverride.headerMediaStorageKey,
        headerMediaMimeType: mediaOverride.headerMediaMimeType ?? template.headerMediaMimeType,
        headerMediaFileName: mediaOverride.headerMediaFileName ?? template.headerMediaFileName,
      };
    }

    headerMedia = await uploadTemplateHeaderMediaForSend(
      credentials.accessToken,
      credentials.phoneNumberId,
      mediaRecord,
      uploaded
    );
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalRecipients: contacts.length, status: 'running' },
  });

  let sentCount = 0;
  const errors: string[] = [];

  for (const contact of contacts) {
    const bodyParams = buildCampaignBodyParams(template.variables, mappings, contact);
    if (bodyParams.some((v) => !v.trim())) {
      const msg = 'missing resolved template variable values';
      errors.push(`${contact.phone}: ${msg}`);
      try {
        const { conversation } = await findOrReopenConversationForInbound({
          workspaceId,
          contactId: contact.id,
          channel: 'whatsapp',
          channelAccountId: credentials.phoneNumberId,
        });
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: 'agent',
            senderName: 'Campaign',
            content: renderTemplateBody(template.bodyPattern, bodyParams.map((v) => v || '—')),
            type: 'template',
            status: 'failed',
            metadata: {
              campaignId: campaign.id,
              templateId: template.id,
              templateName: template.name,
              variables: bodyParams,
              audienceTag,
              sendError: msg,
              events: [{ type: 'failed', at: new Date().toISOString(), detail: msg }],
            },
          },
        });
      } catch (persistErr) {
        console.error('[Campaign] failed to persist missing-var failure', persistErr);
      }
      continue;
    }

    const displayContent = renderTemplateBody(template.bodyPattern, bodyParams);

    try {
      await assertWhatsAppTemplateAffordable({
        workspaceId,
        templateCategory: template.category,
        phoneNumberId: credentials.phoneNumberId,
      });

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
            audienceTag,
            events: [{ type: 'sent', at: new Date().toISOString() }],
          },
        },
      });

      await chargeWhatsAppTemplateUsage({
        workspaceId,
        templateCategory: template.category,
        referenceId: campaignMessage.id,
        templateName: template.name,
        phoneNumberId: credentials.phoneNumberId,
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
      try {
        const { conversation } = await findOrReopenConversationForInbound({
          workspaceId,
          contactId: contact.id,
          channel: 'whatsapp',
          channelAccountId: credentials.phoneNumberId,
        });
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: 'agent',
            senderName: 'Campaign',
            content: displayContent,
            type: 'template',
            status: 'failed',
            metadata: {
              campaignId: campaign.id,
              templateId: template.id,
              templateName: template.name,
              variables: bodyParams,
              audienceTag,
              sendError: msg,
              events: [{ type: 'failed', at: new Date().toISOString(), detail: msg }],
            },
          },
        });
      } catch (persistErr) {
        console.error('[Campaign] failed to persist send failure', persistErr);
      }
    }
  }

  const finalStatus = sentCount > 0 ? 'completed' : 'failed';
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount,
      deliveredCount: sentCount,
      status: finalStatus,
      sentAt: new Date(),
    },
  });

  void emitCampaignFinishedNotification({
    workspaceId,
    campaignId,
    campaignName: campaign.name,
    status: finalStatus,
    sentCount,
    totalRecipients: contacts.length,
  });

  if (sentCount === 0 && errors.length > 0) {
    throw new Error(errors[0] ?? 'Campaign failed to send to any contact');
  }

  return { sentCount, totalRecipients: contacts.length, errors };
}

async function executeEmailCampaignBroadcast(
  campaignId: string,
  workspaceId: string,
  campaign: {
    id: string;
    name: string;
    templateId: string | null;
    audienceType: string;
    audienceFilter: unknown;
  }
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

  const segmentIds = resolveSegmentIdsFromFilter(campaign.audienceType, filter);
  const contacts = await getCampaignAudienceContacts(workspaceId, 'email', segmentIds);
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

  const finalStatus = sentCount > 0 ? 'completed' : 'failed';
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount,
      deliveredCount: sentCount,
      status: finalStatus,
      sentAt: new Date(),
    },
  });

  void emitCampaignFinishedNotification({
    workspaceId,
    campaignId,
    campaignName: campaign.name,
    status: finalStatus,
    sentCount,
    totalRecipients: contacts.length,
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
  if (campaign.status === 'running') {
    throw new Error('Campaign is already running');
  }
  if (campaign.status === 'completed') {
    return {
      sentCount: campaign.sentCount,
      totalRecipients: campaign.totalRecipients,
      errors: [] as string[],
    };
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
