import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { initAiChatModule } from '../modules/ai-chat/container.js';
import { initAiKnowledgeModule } from '../modules/ai-knowledge/container.js';
import type { AiChatHistoryMessage } from '../modules/ai-chat/types/ai-chat.types.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { formatMetaSendError, sendWhatsAppMessage } from './whatsapp.js';
import type { InboundWhatsAppContext } from './ruleBasedFlowEngine.js';
import { ensureAiHandlingStarted } from './conversation-event.service.js';

function logAi(label: string, payload?: unknown) {
  const prefix = '[AiInbound]';
  if (payload === undefined) {
    console.log(`${prefix} ${label}`);
    return;
  }
  console.log(`${prefix} ${label}`, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function buildHistoryFromMessages(
  messages: Array<{ sender: string; content: string }>
): AiChatHistoryMessage[] {
  return messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({
      role: m.sender === 'contact' ? ('user' as const) : ('assistant' as const),
      content: m.content.trim(),
    }));
}

/** FAQ auto-reply when conversation is assigned to AI. */
export async function processAiInbound(ctx: InboundWhatsAppContext): Promise<void> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 20,
      },
    },
  });

  if (!conversation || conversation.assigneeType !== 'ai') {
    logAi('skip — not assigned to AI');
    return;
  }

  const config = await prisma.aiKnowledgeConfig.findUnique({
    where: { workspaceId: ctx.workspaceId },
  });
  if (!config?.venueId) {
    logAi('skip — AI Knowledge not configured');
    return;
  }

  const priorMessages = conversation.messages.filter((m) => m.content !== ctx.text);
  const history = buildHistoryFromMessages(priorMessages);

  const knowledge = initAiKnowledgeModule(prisma);
  const chat = initAiChatModule(knowledge.aiContextService);

  let result;
  try {
    result = await chat.aiChatService.chat(ctx.workspaceId, {
      venueId: config.venueId,
      message: ctx.text,
      customerId: ctx.contactId,
      channel: 'whatsapp',
      history,
    });
  } catch (err) {
    logAi('chat failed', err instanceof Error ? err.message : err);
    return;
  }

  const replyText = result.response.trim();
  if (!replyText) return;

  try {
    const credentials = await getWorkspaceWhatsAppCredentials(ctx.workspaceId);
    const phoneNumberId = ctx.phoneNumberId || credentials.phoneNumberId;
    if (!phoneNumberId) {
      logAi('skip — no WhatsApp phone number id');
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
        conversationId: ctx.conversationId,
        waMessageId: sent.waMessageId,
        sender: 'agent',
        senderName: 'AI Copilot',
        content: replyText,
        type: 'text',
        status: 'sent',
        metadata: {
          source: 'ai_copilot',
          intent: result.intent,
          confidence: result.confidence,
          ...(result.tokensUsed ? { tokensUsed: result.tokensUsed } : {}),
          ...(result.inputTokens ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens ? { outputTokens: result.outputTokens } : {}),
        },
      },
    });

    await prisma.conversation.updateMany({
      where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
      data: {
        lastMessage: replyText,
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

    await ensureAiHandlingStarted({
      conversationId: ctx.conversationId,
      workspaceId: ctx.workspaceId,
      actorName: 'AI Copilot',
      metadata: { source: 'ai_copilot' },
    });

    logAi('reply sent', { intent: result.intent, confidence: result.confidence });
  } catch (err) {
    logAi('WhatsApp send failed', formatMetaSendError(err));
  }
}
