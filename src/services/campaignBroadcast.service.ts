import { prisma } from '../index.js';
import { getEmailService } from '../modules/email/container.js';
import {
  alreadyMessagedContactIdsForCampaign,
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
  isHeaderMediaStorageKeyOwnedByWorkspace,
  parseCampaignHeaderMediaOverride,
} from './campaignHeaderMedia.js';
import { readMediaGalleryFile } from '../modules/media-gallery/media-storage.js';
import {
  isTemplateMediaHeaderFormat,
  uploadTemplateHeaderMediaForSend,
} from './templateSendHeader.js';
import { isMetaRateLimitError } from './whatsapp.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Conservative pacing between WhatsApp sends — well under any Meta messaging
// tier's per-second cap, to avoid tripping quality/rate throttling on a large
// campaign. On an actual 429/throttle response, back off much longer.
const CAMPAIGN_SEND_PACING_MS = 100;
const CAMPAIGN_RATE_LIMIT_BACKOFF_MS = 8_000;
// How often (in contacts) the send loop re-checks for cancellation and
// persists partial progress — also doubles as the reaper's "still alive"
// heartbeat via Campaign.updatedAt.
const CAMPAIGN_PROGRESS_CHECK_INTERVAL = 20;

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
  const allContacts = await getCampaignAudienceContacts(workspaceId, 'whatsapp', segmentIds);
  if (allContacts.length === 0) {
    // Route-level validation rejects this at create/edit time now, but a
    // legacy campaign or an audience that emptied out between scheduling and
    // send (contacts deleted/unsubscribed) could still reach this. Without
    // this throw, the loop below just runs 0 iterations with 0 errors, which
    // doesn't satisfy the "sentCount===0 && errors.length>0" failure check —
    // the campaign silently completes as 'failed' while /send still returns
    // HTTP 200 "Campaign broadcast completed".
    throw new Error('No contacts match the selected audience');
  }
  // Resuming a campaign (stuck-'running' reset, retried request) must not
  // re-message contacts this campaign already successfully reached.
  const alreadySent = await alreadyMessagedContactIdsForCampaign(campaignId, 'whatsapp');
  const contacts = allContacts.filter((c) => !alreadySent.has(c.id));
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
      if (!isHeaderMediaStorageKeyOwnedByWorkspace(mediaOverride.headerMediaStorageKey, workspaceId)) {
        throw new Error('Header media does not belong to this workspace');
      }
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
      workspaceId,
      mediaRecord,
      uploaded
    );
  }

  // status: 'running' is already set by executeCampaignBroadcast's atomic
  // claim before this function runs — only totalRecipients needs writing here.
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalRecipients: allContacts.length },
  });

  let sentCount = 0;
  let cancelled = false;
  const errors: string[] = [];

  for (const [i, contact] of contacts.entries()) {
    // Pace every send, not just the periodic check below — otherwise a large
    // campaign bursts CAMPAIGN_PROGRESS_CHECK_INTERVAL sends unthrottled and
    // only pauses once every N contacts, which barely rate-limits anything.
    if (i > 0) {
      await sleep(CAMPAIGN_SEND_PACING_MS);
    }
    if (i > 0 && i % CAMPAIGN_PROGRESS_CHECK_INTERVAL === 0) {
      const stillRunning = await prisma.campaign.updateMany({
        where: { id: campaignId, status: 'running' },
        data: { sentCount: alreadySent.size + sentCount },
      });
      if (stillRunning.count === 0) {
        cancelled = true;
        break;
      }
    }

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
      if (isMetaRateLimitError(err)) {
        // The whole number is being throttled, not just this contact —
        // pause the batch before continuing rather than hammering the same
        // limit on every remaining recipient.
        console.warn('[Campaign] rate limited by Meta, backing off', { campaignId });
        await sleep(CAMPAIGN_RATE_LIMIT_BACKOFF_MS);
      }
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

  // Cumulative across resumes — alreadySent was captured before this run, so
  // it doesn't include this run's own sends yet.
  const cumulativeSent = alreadySent.size + sentCount;
  const finalStatus = cancelled ? 'cancelled' : cumulativeSent > 0 ? 'completed' : 'failed';
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount: cumulativeSent,
      deliveredCount: cumulativeSent,
      status: finalStatus,
      ...(cancelled ? {} : { sentAt: new Date() }),
    },
  });

  if (finalStatus !== 'cancelled') {
    void emitCampaignFinishedNotification({
      workspaceId,
      campaignId,
      campaignName: campaign.name,
      status: finalStatus,
      sentCount: cumulativeSent,
      totalRecipients: allContacts.length,
    });
  }

  if (!cancelled && cumulativeSent === 0 && errors.length > 0) {
    throw new Error(errors[0] ?? 'Campaign failed to send to any contact');
  }

  return { sentCount: cumulativeSent, totalRecipients: allContacts.length, errors };
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
  const allContacts = await getCampaignAudienceContacts(workspaceId, 'email', segmentIds);
  if (allContacts.length === 0) {
    throw new Error('No contacts with email addresses in the selected audience');
  }
  // Resuming a campaign (stuck-'running' reset, retried request) must not
  // re-email contacts this campaign already successfully reached.
  const alreadySent = await alreadyMessagedContactIdsForCampaign(campaignId, 'email');
  const contacts = allContacts.filter((c) => !alreadySent.has(c.id));

  const emailService = getEmailService();

  // status: 'running' is already set by executeCampaignBroadcast's atomic
  // claim before this function runs — only totalRecipients needs writing here.
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalRecipients: allContacts.length },
  });

  let sentCount = 0;
  let cancelled = false;
  const errors: string[] = [];

  for (const [i, contact] of contacts.entries()) {
    if (i > 0 && i % CAMPAIGN_PROGRESS_CHECK_INTERVAL === 0) {
      const stillRunning = await prisma.campaign.updateMany({
        where: { id: campaignId, status: 'running' },
        data: { sentCount: alreadySent.size + sentCount },
      });
      if (stillRunning.count === 0) {
        cancelled = true;
        break;
      }
    }

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

  // Cumulative across resumes — alreadySent was captured before this run, so
  // it doesn't include this run's own sends yet.
  const cumulativeSent = alreadySent.size + sentCount;
  const finalStatus = cancelled ? 'cancelled' : cumulativeSent > 0 ? 'completed' : 'failed';
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount: cumulativeSent,
      deliveredCount: cumulativeSent,
      status: finalStatus,
      ...(cancelled ? {} : { sentAt: new Date() }),
    },
  });

  if (finalStatus !== 'cancelled') {
    void emitCampaignFinishedNotification({
      workspaceId,
      campaignId,
      campaignName: campaign.name,
      status: finalStatus,
      sentCount: cumulativeSent,
      totalRecipients: allContacts.length,
    });
  }

  if (!cancelled && cumulativeSent === 0 && errors.length > 0) {
    throw new Error(errors[0] ?? 'Campaign failed to send to any contact');
  }

  return { sentCount: cumulativeSent, totalRecipients: allContacts.length, errors };
}

export async function executeCampaignBroadcast(campaignId: string, workspaceId: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) {
    throw new Error('Campaign not found');
  }
  if (campaign.status === 'completed') {
    return {
      sentCount: campaign.sentCount,
      totalRecipients: campaign.totalRecipients,
      errors: [] as string[],
    };
  }

  // Atomic claim: only one concurrent caller can flip status → 'running'.
  // This has to happen here, before any audience fetch / media upload / send
  // work — not deep inside the per-channel functions, which left a wide
  // window where a double-click, a retried request, or a scheduled job
  // racing a manual send could all pass a plain status read and each blast
  // the full audience.
  const claim = await prisma.campaign.updateMany({
    where: {
      id: campaignId,
      workspaceId,
      // 'cancelled' is resumable too — per-contact idempotency makes it safe
      // to pick back up where a stop left off instead of starting over.
      status: { in: ['draft', 'scheduled', 'failed', 'cancelled'] },
    },
    data: { status: 'running' },
  });
  if (claim.count === 0) {
    throw new Error('Campaign is already running or has already completed');
  }

  try {
    const filter = parseAudienceFilter(campaign.audienceFilter);
    const channel = filter.channel ?? 'whatsapp';

    if (channel === 'whatsapp') {
      return await executeWhatsAppCampaignBroadcast(campaignId, workspaceId, campaign);
    }
    if (channel === 'email') {
      return await executeEmailCampaignBroadcast(campaignId, workspaceId, campaign);
    }

    throw new Error(`Campaign channel "${channel}" is not supported for sending yet`);
  } catch (err) {
    // Claimed but never reached (or threw before) the per-channel function's
    // own final-status write — e.g. template/credentials validation failed.
    // Without this the campaign is left stuck in 'running' forever, and
    // (for the scheduled/worker path, which has no HTTP response to return
    // the error over) the operator had no way to see why it failed at all.
    const message = err instanceof Error ? err.message : 'Campaign failed';
    await prisma.campaign
      .updateMany({
        where: { id: campaignId, status: 'running' },
        data: { status: 'failed', lastError: message.slice(0, 500) },
      })
      .catch(() => {});
    await emitCampaignFinishedNotification({
      workspaceId,
      campaignId,
      campaignName: campaign.name,
      status: 'failed',
      sentCount: campaign.sentCount,
      totalRecipients: campaign.totalRecipients,
    }).catch(() => {});
    throw err;
  }
}
