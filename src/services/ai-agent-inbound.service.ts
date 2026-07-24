import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { getIo } from '../socket.js';
import { ConversationService } from '../modules/ai-agent/conversation.service.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { formatMetaSendError, sendWhatsAppMessage } from './whatsapp.js';
import type { InboundWhatsAppContext } from './ruleBasedFlowEngine.js';
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

/**
 * WhatsApp reply via published AI Agent (hybrid retrieval / ConversationService).
 * Continues the same AgentChatConversation keyed by inbox conversation id.
 */
export async function processAiAgentInbound(ctx: InboundWhatsAppContext): Promise<void> {
  const text = ctx.text?.trim();
  if (!text || text === '[media]') {
    logAiAgent('skip — empty or media-only message');
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
    select: { assigneeType: true, assigneeId: true, channelAccountId: true },
  });

  if (!conversation || conversation.assigneeType !== 'ai_agent' || !conversation.assigneeId) {
    logAiAgent('skip — not assigned to AI agent');
    return;
  }

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
      metadata: { source: 'ai_agent' },
    }).catch((err) =>
      logAiAgent('event AI_HANDLING_STARTED failed', err instanceof Error ? err.message : err)
    );
  };

  const resolveWa = async () => {
    const phoneNumberId = ctx.phoneNumberId || conversation.channelAccountId || undefined;
    const credentials = await getWorkspaceWhatsAppCredentials(ctx.workspaceId, phoneNumberId);
    const resolvedPhoneId = phoneNumberId || credentials.phoneNumberId;
    if (!resolvedPhoneId) throw new Error('No WhatsApp phone number id');
    return { credentials, resolvedPhoneId };
  };

  const sendText = async (reply: string, meta?: Record<string, unknown>) => {
    const { credentials, resolvedPhoneId } = await resolveWa();
    const sent = await sendWhatsAppMessage(
      credentials.accessToken,
      resolvedPhoneId,
      ctx.contactPhone,
      reply
    );
    const message = await prisma.message.create({
      data: {
        waMessageId: sent.waMessageId,
        conversationId: ctx.conversationId,
        sender: 'agent',
        senderName: agent.name,
        content: reply,
        type: 'text',
        status: 'sent',
        metadata: { source: 'ai_agent', agentId, ...meta },
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
    return { credentials, resolvedPhoneId, message };
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
        const { credentials, resolvedPhoneId } = await sendText(mediaSendAck(asset.title), {
          mediaOfferAffirm: true,
        });
        const mediaResult = await sendAgentMediaAsset({
          workspaceId: ctx.workspaceId,
          agentId,
          agentName: agent.name,
          conversationId: ctx.conversationId,
          contactPhone: ctx.contactPhone,
          accessToken: credentials.accessToken,
          phoneNumberId: resolvedPhoneId,
          asset,
        });
        logAiAgent('media gallery affirm', mediaResult);
      }
    } catch (err) {
      logAiAgent('media affirm failed', formatMetaSendError(err));
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
    } catch (err) {
      logAiAgent('chat retry failed', err instanceof Error ? err.message : err);
      return;
    }
    finalReply = finalResult.reply?.trim() || '';
  }

  if (!finalReply) {
    logAiAgent('skip — empty reply from agent');
    return;
  }

  try {
    const { credentials, resolvedPhoneId, message } = await sendText(finalReply, {
      retrievalPath: finalResult.retrievalPath ?? null,
      mediaAttachment: finalResult.mediaAttachment?.action ?? 'none',
    });

    logAiAgent('replied', {
      agentId,
      path: finalResult.retrievalPath,
      messageId: message.id,
      media: finalResult.mediaAttachment,
    });

    if (finalResult.mediaAttachment?.action === 'send') {
      const asset = await loadAgentMediaAsset(
        ctx.workspaceId,
        finalResult.mediaAttachment.mediaId
      );
      if (!asset) {
        logAiAgent('media gallery', { status: 'skipped', reason: 'asset_missing' });
      } else {
        const mediaResult = await sendAgentMediaAsset({
          workspaceId: ctx.workspaceId,
          agentId,
          agentName: agent.name,
          conversationId: ctx.conversationId,
          contactPhone: ctx.contactPhone,
          accessToken: credentials.accessToken,
          phoneNumberId: resolvedPhoneId,
          asset,
        });
        logAiAgent('media gallery', mediaResult);
        if (mediaResult.status !== 'sent') {
          // User already got ack text — surface failure in logs; optional follow-up later.
          logAiAgent('media send failed after ack', mediaResult);
        }
      }
    } else {
      logAiAgent('media gallery', finalResult.mediaAttachment ?? { action: 'none' });
    }
  } catch (err) {
    logAiAgent('WhatsApp send failed', formatMetaSendError(err));
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
      contact: { select: { phone: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { sender: true, content: true },
      },
    },
  });

  if (!conv || conv.assigneeType !== 'ai_agent' || !conv.assigneeId || !conv.contact?.phone) {
    return;
  }

  const last = conv.messages[0];
  if (!last || last.sender !== 'contact') return;
  const text = last.content?.trim();
  if (!text || text === '[media]') return;

  logAiAgent('kick reply after assign', { conversationId, preview: text.slice(0, 80) });
  await processAiAgentInbound({
    workspaceId,
    conversationId,
    contactId: conv.contactId,
    contactPhone: conv.contact.phone,
    text,
    phoneNumberId: conv.channelAccountId ?? undefined,
  });
}
