import type { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { getRedis } from '../lib/redis.js';
import { getIo } from '../socket.js';
import { ConversationService } from '../modules/ai-agent/conversation.service.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { formatMetaSendError, sendWhatsAppMessage } from './whatsapp.js';
import type { InboundWhatsAppContext } from './ruleBasedFlowEngine.js';

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
    select: { assigneeType: true, assigneeId: true },
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
  const existingChat = await prisma.agentChatConversation.findFirst({
    where: { workspaceId: ctx.workspaceId, agentId, channel: channelKey },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });

  const conversationService = new ConversationService(aiAgentRuntime());
  let result;
  try {
    result = await conversationService.chat({
      workspaceId: ctx.workspaceId,
      agentId,
      conversationId: existingChat?.id,
      message: text,
      channel: channelKey,
    });
  } catch (err) {
    logAiAgent('chat failed', err instanceof Error ? err.message : err);
    return;
  }

  const replyText = result.reply?.trim();
  if (!replyText) return;

  try {
    const credentials = await getWorkspaceWhatsAppCredentials(ctx.workspaceId, ctx.phoneNumberId);
    const phoneNumberId = ctx.phoneNumberId || credentials.phoneNumberId;
    if (!phoneNumberId) {
      logAiAgent('skip — no WhatsApp phone number id');
      return;
    }
    const sent = await sendWhatsAppMessage(
      credentials.accessToken,
      phoneNumberId,
      ctx.contactPhone,
      replyText
    );

    const message = await prisma.message.create({
      data: {
        waMessageId: sent.waMessageId,
        conversationId: ctx.conversationId,
        sender: 'agent',
        senderName: agent.name,
        content: replyText,
        type: 'text',
        status: 'sent',
        metadata: {
          source: 'ai_agent',
          agentId,
          retrievalPath: result.retrievalPath ?? null,
        },
      },
    });

    await prisma.conversation.updateMany({
      where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
      data: {
        lastMessage: replyText.slice(0, 200),
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

    logAiAgent('replied', {
      agentId,
      path: result.retrievalPath,
      messageId: message.id,
    });
  } catch (err) {
    logAiAgent('WhatsApp send failed', formatMetaSendError(err));
  }
}
