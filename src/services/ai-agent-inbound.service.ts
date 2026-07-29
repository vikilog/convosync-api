import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { getIo } from '../socket.js';
import { ConversationService } from '../modules/ai-agent/conversation.service.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { formatMetaSendError, sendWhatsAppMessage } from './whatsapp.js';
import { getWorkspaceInstagramCredentials } from './instagramCredentials.js';
import {
  formatInstagramSendError,
  sendInstagramMessage,
} from './instagram.js';
import {
  sendInstagramMediaMessage,
  resolveOutboundInstagramKind,
} from './instagramMedia.js';
import {
  formatMessengerSendError,
  sendMessengerMediaMessage,
  sendMessengerMessage,
} from './messenger.js';
import { getWorkspaceMessengerCredentials } from './messengerCredentials.js';
import {
  parseInstagramScopedUserId,
  parseMessengerPsid,
} from '../lib/channelContact.js';
import type { InboundMessagingContext } from './ruleBasedFlowEngine.js';
import { ensureAiHandlingStarted } from './conversation-event.service.js';
import { seedAgentChatFromInbox } from './ai-agent-inbox-seed.service.js';
import {
  clearPendingMediaOffer,
  getPendingMediaOffer,
  looksLikeMediaAffirmation,
  mediaSendAck,
} from '../modules/ai-agent/media/media-offer.js';
import {
  loadAgentMediaAsset,
  sendAgentMediaAsset,
} from '../modules/ai-agent/media/send-media.service.js';
import {
  mediaTypeFromMime,
  resolveMetaFetchableMediaUrl,
} from '../modules/media-gallery/media-storage.js';
import { previewForMessage } from './whatsappMedia.js';

function logAiAgent(label: string, payload?: unknown) {
  const prefix = '[AiAgentInbound]';
  if (payload === undefined) {
    console.log(`${prefix} ${label}`);
    return;
  }
  console.log(
    `${prefix} ${label}`,
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  );
}

/** Minimal Fastify-shaped runtime for ConversationService (prisma + redis only). */
function aiAgentRuntime(): FastifyInstance {
  return { prisma, redis: getRedis() } as unknown as FastifyInstance;
}

function resolveChannel(
  ctxChannel: InboundMessagingContext['channel'],
  conversationChannel: string | null | undefined,
  contactPhone?: string
): 'whatsapp' | 'instagram' | 'messenger' {
  if (ctxChannel === 'instagram' || ctxChannel === 'messenger' || ctxChannel === 'whatsapp') {
    return ctxChannel;
  }
  if (conversationChannel === 'instagram' || conversationChannel === 'messenger') {
    return conversationChannel;
  }
  // Infer from contact id prefix when Conversation.channel is missing/wrong.
  if (contactPhone?.startsWith('ig:')) return 'instagram';
  if (contactPhone?.startsWith('fb:')) return 'messenger';
  return 'whatsapp';
}

function formatChannelSendError(
  channel: 'whatsapp' | 'instagram' | 'messenger',
  err: unknown
): unknown {
  if (channel === 'instagram') return formatInstagramSendError(err);
  if (channel === 'messenger') return formatMessengerSendError(err);
  return formatMetaSendError(err);
}

/**
 * AI Agent inbound for WhatsApp + Instagram + Messenger inbox threads.
 * Continues the same AgentChatConversation keyed by inbox conversation id.
 */
export async function processAiAgentInbound(ctx: InboundMessagingContext): Promise<void> {
  const text = ctx.text?.trim();
  if (!text || text === '[media]') {
    logAiAgent('skip — empty or media-only message');
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
    select: {
      assigneeType: true,
      assigneeId: true,
      channelAccountId: true,
      channel: true,
    },
  });

  if (!conversation || conversation.assigneeType !== 'ai_agent' || !conversation.assigneeId) {
    logAiAgent('skip — not assigned to AI agent');
    return;
  }

  const channel = resolveChannel(ctx.channel, conversation.channel, ctx.contactPhone);

  const agentId = conversation.assigneeId;
  const agent = await prisma.aiAgent.findFirst({
    where: {
      id: agentId,
      workspaceId: ctx.workspaceId,
      isEnabled: true,
      isPublished: true,
      category: { in: ['ai_agent', 'responsive'] },
    },
  });
  if (!agent) {
    logAiAgent('skip — agent missing / unpublished', { agentId });
    return;
  }

  const channelKey = `inbox:${ctx.conversationId}`;

  const finishHandling = async () => {
    await ensureAiHandlingStarted({
      conversationId: ctx.conversationId,
      workspaceId: ctx.workspaceId,
      actorId: agentId,
      actorName: agent.name,
      metadata: { source: 'ai_agent', channel },
    }).catch((err) =>
      logAiAgent('event AI_HANDLING_STARTED failed', err instanceof Error ? err.message : err)
    );
  };

  const persistOutbound = async (
    reply: string,
    waMessageId: string | undefined,
    meta?: Record<string, unknown>
  ) => {
    const message = await prisma.message.create({
      data: {
        waMessageId: waMessageId || null,
        conversationId: ctx.conversationId,
        sender: 'agent',
        senderName: agent.name,
        content: reply,
        type: 'text',
        status: 'sent',
        metadata: { source: 'ai_agent', agentId, channel, ...meta },
      },
    });
    await prisma.conversation.updateMany({
      where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
      data: { lastMessage: reply.slice(0, 200), lastMessageAt: new Date() },
    });
    getIo().to(ctx.workspaceId).emit('new_message', { conversationId: ctx.conversationId, message });
    getIo().to(ctx.workspaceId).emit('conversation_updated', {
      conversationId: ctx.conversationId,
    });
    return message;
  };

  type SendBundle =
    | {
        channel: 'whatsapp';
        accessToken: string;
        phoneNumberId: string;
        message: Awaited<ReturnType<typeof persistOutbound>>;
      }
    | {
        channel: 'instagram' | 'messenger';
        pageId: string;
        pageAccessToken: string;
        recipientId: string;
        message: Awaited<ReturnType<typeof persistOutbound>>;
      };

  const sendText = async (reply: string, meta?: Record<string, unknown>): Promise<SendBundle> => {
    if (channel === 'instagram') {
      const recipientId = parseInstagramScopedUserId(ctx.contactPhone);
      if (!recipientId) throw new Error('Contact has no Instagram user id');
      const credentials = await getWorkspaceInstagramCredentials(
        ctx.workspaceId,
        conversation.channelAccountId
      );
      const lastContactMsg = await prisma.message.findFirst({
        where: {
          conversationId: ctx.conversationId,
          sender: 'contact',
          waMessageId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { waMessageId: true },
      });
      const sent = await sendInstagramMessage(
        credentials.pageId,
        credentials.pageAccessToken,
        recipientId,
        reply,
        {
          replyToMid: lastContactMsg?.waMessageId || undefined,
          instagramUserId: credentials.instagramUserId,
        }
      );
      const message = await persistOutbound(reply, sent.messageId, meta);
      return {
        channel: 'instagram',
        pageId: credentials.pageId,
        pageAccessToken: credentials.pageAccessToken,
        recipientId,
        message,
      };
    }

    if (channel === 'messenger') {
      const recipientId = parseMessengerPsid(ctx.contactPhone);
      if (!recipientId) throw new Error('Contact has no Messenger PSID');
      const credentials = await getWorkspaceMessengerCredentials(
        ctx.workspaceId,
        conversation.channelAccountId
      );
      const sent = await sendMessengerMessage(
        credentials.pageId,
        credentials.pageAccessToken,
        recipientId,
        reply
      );
      const message = await persistOutbound(reply, sent.messageId, meta);
      return {
        channel: 'messenger',
        pageId: credentials.pageId,
        pageAccessToken: credentials.pageAccessToken,
        recipientId,
        message,
      };
    }

    const phoneNumberId = ctx.phoneNumberId || conversation.channelAccountId || undefined;
    const credentials = await getWorkspaceWhatsAppCredentials(ctx.workspaceId, phoneNumberId);
    const resolvedPhoneId = phoneNumberId || credentials.phoneNumberId;
    if (!resolvedPhoneId) throw new Error('No WhatsApp phone number id');
    const sent = await sendWhatsAppMessage(
      credentials.accessToken,
      resolvedPhoneId,
      ctx.contactPhone,
      reply
    );
    const message = await persistOutbound(reply, sent.waMessageId, meta);
    return {
      channel: 'whatsapp',
      accessToken: credentials.accessToken,
      phoneNumberId: resolvedPhoneId,
      message,
    };
  };

  const sendMedia = async (bundle: SendBundle, mediaId: string) => {
    const asset = await loadAgentMediaAsset(ctx.workspaceId, mediaId);
    if (!asset) {
      logAiAgent('media gallery', { status: 'skipped', reason: 'asset_missing' });
      return;
    }

    if (bundle.channel === 'whatsapp') {
      const mediaResult = await sendAgentMediaAsset({
        workspaceId: ctx.workspaceId,
        agentId,
        agentName: agent.name,
        conversationId: ctx.conversationId,
        contactPhone: ctx.contactPhone,
        accessToken: bundle.accessToken,
        phoneNumberId: bundle.phoneNumberId,
        asset,
      });
      logAiAgent('media gallery', mediaResult);
      return;
    }

    // IG / Messenger: Meta requires a fetchable HTTPS URL (no WA-style upload id).
    const mediaUrl = await resolveMetaFetchableMediaUrl(asset);
    if (!mediaUrl) {
      logAiAgent('media gallery', {
        status: 'skipped',
        reason: 'meta_needs_fetchable_https_url',
        mediaId: asset.id,
        channel: bundle.channel,
      });
      return;
    }
    try {
      const kind = resolveOutboundInstagramKind(asset.mimeType || '');
      const messageKind = kind === 'file' ? 'document' : kind;
      const mimeType = asset.mimeType || 'application/octet-stream';
      const fileName = asset.filename || asset.title || 'attachment';
      const caption = asset.title;
      const preview = previewForMessage(messageKind, fileName, caption);
      const sent =
        bundle.channel === 'messenger'
          ? await sendMessengerMediaMessage(
              bundle.pageId,
              bundle.pageAccessToken,
              bundle.recipientId,
              kind,
              mediaUrl
            )
          : await sendInstagramMediaMessage(
              bundle.pageId,
              bundle.pageAccessToken,
              bundle.recipientId,
              kind,
              mediaUrl
            );
      const message = await prisma.message.create({
        data: {
          waMessageId: sent.messageId,
          conversationId: ctx.conversationId,
          sender: 'agent',
          senderName: agent.name,
          content: preview,
          type: messageKind,
          status: 'sent',
          metadata: {
            source: 'ai_agent',
            agentId,
            channel: bundle.channel,
            mediaAssetId: asset.id,
            mimeType,
            fileName,
            caption,
            // Gallery key works with /messages/:id/attachment (same as WA AI path).
            storageKey: asset.storageKey || undefined,
            mediaLink: mediaUrl,
            mediaType: asset.type || mediaTypeFromMime(mimeType, fileName),
          },
        },
      });
      await prisma.conversation.updateMany({
        where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
        data: {
          lastMessage: preview.slice(0, 200),
          lastMessageAt: new Date(),
        },
      });
      getIo().to(ctx.workspaceId).emit('new_message', {
        conversationId: ctx.conversationId,
        message,
      });
      getIo().to(ctx.workspaceId).emit('conversation_updated', {
        conversationId: ctx.conversationId,
      });
      await clearPendingMediaOffer(ctx.workspaceId, ctx.conversationId);
      logAiAgent('media gallery', {
        status: 'sent',
        mediaId: asset.id,
        channel: bundle.channel,
      });
    } catch (err) {
      logAiAgent(
        `${bundle.channel} media send failed`,
        formatChannelSendError(bundle.channel, err)
      );
    }
  };

  // Affirm previous "Bhej doon?" offer — send file, skip LLM.
  const pendingOffer = await getPendingMediaOffer(ctx.workspaceId, ctx.conversationId);
  if (pendingOffer && looksLikeMediaAffirmation(text)) {
    try {
      const asset = await loadAgentMediaAsset(ctx.workspaceId, pendingOffer.mediaId);
      if (!asset) {
        await clearPendingMediaOffer(ctx.workspaceId, ctx.conversationId);
        logAiAgent('media affirm — asset missing');
      } else {
        const bundle = await sendText(mediaSendAck(asset.title), { mediaOfferAffirm: true });
        await sendMedia(bundle, asset.id);
      }
    } catch (err) {
      logAiAgent('media affirm failed', formatChannelSendError(channel, err));
    }
    await finishHandling();
    return;
  }
  if (pendingOffer) {
    await clearPendingMediaOffer(ctx.workspaceId, ctx.conversationId);
  }

  const seeded = await seedAgentChatFromInbox({
    workspaceId: ctx.workspaceId,
    agentId,
    inboxConversationId: ctx.conversationId,
    excludeContactText: text,
  });
  logAiAgent('inbox history seed', {
    agentChatId: seeded.agentChatId,
    seeded: seeded.seeded,
    channel,
  });

  const conversationService = new ConversationService(aiAgentRuntime());
  let result;
  try {
    result = await conversationService.chat({
      workspaceId: ctx.workspaceId,
      agentId,
      conversationId: seeded.agentChatId,
      message: text,
      channel: channelKey,
      mediaConversationId: ctx.conversationId,
    });
  } catch (err) {
    logAiAgent('chat failed', err instanceof Error ? err.message : err);
    return;
  }

  let finalResult = result;
  let finalReply = result.reply?.trim() || '';

  if (result.intent === 'timeout') {
    logAiAgent('retry after idle-timeout stub', { agentChatId: seeded.agentChatId });
    await prisma.agentChatConversation
      .update({
        where: { id: seeded.agentChatId },
        data: { isActive: false, closedReason: 'idle_timeout', closedAt: new Date() },
      })
      .catch(() => undefined);
    const retrySeed = await seedAgentChatFromInbox({
      workspaceId: ctx.workspaceId,
      agentId,
      inboxConversationId: ctx.conversationId,
      excludeContactText: text,
    });
    try {
      finalResult = await conversationService.chat({
        workspaceId: ctx.workspaceId,
        agentId,
        conversationId: retrySeed.agentChatId,
        message: text,
        channel: channelKey,
        mediaConversationId: ctx.conversationId,
      });
      finalReply = finalResult.reply?.trim() || '';
    } catch (err) {
      logAiAgent('chat retry failed', err instanceof Error ? err.message : err);
      return;
    }
  }

  if (!finalReply) {
    logAiAgent('skip — empty reply from agent');
    return;
  }

  try {
    // IG text limit 1000; Messenger ~2000 — trim rather than failing the turn.
    const outboundReply =
      channel === 'instagram' && finalReply.length > 1000
        ? `${finalReply.slice(0, 990)}…`
        : channel === 'messenger' && finalReply.length > 2000
          ? `${finalReply.slice(0, 1990)}…`
          : finalReply;

    const bundle = await sendText(outboundReply, {
      retrievalPath: finalResult.retrievalPath ?? null,
      mediaAttachment: finalResult.mediaAttachment?.action ?? 'none',
    });

    logAiAgent('replied', {
      agentId,
      channel,
      path: finalResult.retrievalPath,
      messageId: bundle.message.id,
      media: finalResult.mediaAttachment,
    });

    if (finalResult.mediaAttachment?.action === 'send') {
      await sendMedia(bundle, finalResult.mediaAttachment.mediaId);
    } else {
      logAiAgent('media gallery', finalResult.mediaAttachment ?? { action: 'none' });
    }
  } catch (err) {
    logAiAgent(`${channel} send failed`, formatChannelSendError(channel, err));
    return;
  }

  await finishHandling();
}

/**
 * After assigning an AI agent, reply to the latest contact message (if any)
 * so the agent doesn't wait for a brand-new inbound webhook.
 */
export async function kickAiAgentReplyForLatestContactMessage(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      assigneeType: true,
      assigneeId: true,
      contactId: true,
      channelAccountId: true,
      channel: true,
      contact: { select: { phone: true } },
      messages: {
        where: { sender: 'contact' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { sender: true, content: true },
      },
    },
  });

  if (!conv || conv.assigneeType !== 'ai_agent' || !conv.assigneeId || !conv.contact?.phone) {
    return;
  }

  // Prefer last text-like contact message (skip empty / bare media stubs).
  const last = conv.messages.find((m) => {
    const text = m.content?.trim();
    return Boolean(text) && text !== '[media]';
  });
  if (!last) return;
  const text = last.content.trim();

  logAiAgent('kick reply after assign', {
    conversationId,
    channel: resolveChannel(undefined, conv.channel, conv.contact.phone),
    preview: text.slice(0, 80),
  });
  await processAiAgentInbound({
    workspaceId,
    conversationId,
    contactId: conv.contactId,
    contactPhone: conv.contact.phone,
    text,
    phoneNumberId: conv.channelAccountId ?? undefined,
    channel: resolveChannel(undefined, conv.channel, conv.contact.phone),
  });
}
