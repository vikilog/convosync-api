/**
 * Shared AI Agent turn for inbox + voice (no channel send).
 * Voice Pipecat POSTs here; WhatsApp inbound still sends via Meta after chat().
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { recordAiAgentTurn } from '../lib/otel-metrics.js';
import { ConversationService } from '../modules/ai-agent/conversation.service.js';

function aiAgentRuntime(): FastifyInstance {
  return { prisma, redis: getRedis() } as unknown as FastifyInstance;
}

export class AiAgentRespondError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string
  ) {
    super(message);
  }
}

export async function respondAiAgentTurn(input: {
  workspaceId: string;
  conversationId: string;
  message: string;
  /** Defaults to inbox channel so voice continues WhatsApp context. */
  channel?: string;
}): Promise<{ response: string; agentId: string; retrievalPath?: string }> {
  const text = input.message.trim();
  if (!text) {
    throw new AiAgentRespondError('Empty message', 400, 'EMPTY_MESSAGE');
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    select: { assigneeType: true, assigneeId: true },
  });
  if (!conversation || conversation.assigneeType !== 'ai_agent' || !conversation.assigneeId) {
    throw new AiAgentRespondError(
      'Conversation is not assigned to an AI agent',
      409,
      'NOT_AI_ASSIGNED'
    );
  }

  const agentId = conversation.assigneeId;
  const agent = await prisma.aiAgent.findFirst({
    where: {
      id: agentId,
      workspaceId: input.workspaceId,
      isEnabled: true,
      isPublished: true,
      category: { in: ['ai_agent', 'responsive'] },
    },
    select: { id: true },
  });
  if (!agent) {
    throw new AiAgentRespondError(
      'AI agent missing, disabled, or unpublished',
      404,
      'AGENT_UNAVAILABLE'
    );
  }

  const channelKey = input.channel ?? `inbox:${input.conversationId}`;
  const existingChat = await prisma.agentChatConversation.findFirst({
    where: { workspaceId: input.workspaceId, agentId, channel: channelKey },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });

  const t0 = Date.now();
  try {
    const result = await new ConversationService(aiAgentRuntime()).chat({
      workspaceId: input.workspaceId,
      agentId,
      conversationId: existingChat?.id,
      message: text,
      channel: channelKey,
    });

    const response = result.reply?.trim() || '';
    if (!response) {
      recordAiAgentTurn({
        durationMs: Date.now() - t0,
        path: result.retrievalPath,
        workspaceId: input.workspaceId,
        ok: false,
      });
      throw new AiAgentRespondError('Empty agent reply', 502, 'EMPTY_REPLY');
    }

    recordAiAgentTurn({
      durationMs: Date.now() - t0,
      path: result.retrievalPath,
      workspaceId: input.workspaceId,
      ok: true,
    });

    return {
      response,
      agentId,
      retrievalPath: result.retrievalPath,
    };
  } catch (err) {
    if (!(err instanceof AiAgentRespondError && err.code === 'EMPTY_REPLY')) {
      recordAiAgentTurn({
        durationMs: Date.now() - t0,
        workspaceId: input.workspaceId,
        ok: false,
      });
    }
    throw err;
  }
}
