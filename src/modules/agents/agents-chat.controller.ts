import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../middleware/auth.js';
import { AgentTestError, testAgentChat } from '../../services/agent-test.service.js';
import { OpenAiProviderError } from '../ai-chat/providers/openai.provider.js';
import { ConversationService } from '../ai-agent/conversation.service.js';
import { getRetrievalStats } from '../ai-agent/hybrid/analytics.js';
import {
  PreviewSttError,
  synthesizePreviewSpeech,
  transcribePreviewAudio,
} from '../../services/preview-stt.service.js';
import type { AgentChatBody, AgentTestBody, VoicePreviewTtsBody } from '../../routes/agents.schemas.js';
import { getAgentOr404 } from './agents.helpers.js';

export async function chatWithAgent(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  if (!workspaceId) {
    return reply.code(401).send({ success: false, message: 'Workspace required' });
  }
  const { id: agentId } = request.params as { id: string };
  const body = request.body as AgentChatBody;

  const agent = await getAgentOr404(workspaceId, agentId);
  if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

  const conversationService = new ConversationService(request.server);

  try {
    const result = await conversationService.chat({
      workspaceId,
      agentId,
      conversationId: body.conversationId,
      message: body.message,
      channel: body.channel,
    });

    return reply.send({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Chat failed';
    request.server.log.error(error);
    return reply.status(500).send({ success: false, message });
  }
}

/** Voice preview: MediaRecorder blob → agent's STT provider → text */
export async function voicePreviewStt(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  if (!workspaceId) {
    return reply.code(401).send({ success: false, message: 'Workspace required' });
  }
  const { id: agentId } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, agentId);
  if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

  try {
    let buffer: Buffer | null = null;
    let mimeType = 'audio/webm';
    let fileName = 'preview.webm';
    let language = '';

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        buffer = await part.toBuffer();
        mimeType = part.mimetype || mimeType;
        fileName = part.filename || fileName;
      } else if (part.type === 'field' && part.fieldname === 'language') {
        language = String(part.value || '').trim();
      }
    }

    if (!buffer?.length) {
      return reply.code(400).send({ success: false, message: 'audio file is required' });
    }

    const result = await transcribePreviewAudio({
      buffer,
      mimeType,
      fileName,
      language: language || undefined,
      sttProvider: agent.voiceSttProvider || 'cartesia',
    });

    return reply.send({ success: true, data: result });
  } catch (err) {
    if (err instanceof PreviewSttError) {
      return reply.code(err.statusCode).send({
        success: false,
        message: err.message,
        code: err.code,
      });
    }
    request.server.log.error(err);
    return reply.code(500).send({ success: false, message: 'STT failed' });
  }
}

/** Voice preview: text → agent's TTS provider → audio bytes */
export async function voicePreviewTts(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  if (!workspaceId) {
    return reply.code(401).send({ success: false, message: 'Workspace required' });
  }
  const { id: agentId } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, agentId);
  if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

  const body = request.body as VoicePreviewTtsBody;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return reply.code(400).send({ success: false, message: 'text is required' });
  }

  try {
    const result = await synthesizePreviewSpeech({
      text,
      ttsProvider: agent.voiceTtsProvider || 'cartesia',
      ttsVoiceId: agent.voiceTtsVoiceId,
    });
    return reply
      .header('X-TTS-Ms', String(result.ttsMs))
      .header('X-TTS-Provider', result.provider)
      .type(result.mimeType)
      .send(result.buffer);
  } catch (err) {
    if (err instanceof PreviewSttError) {
      return reply.code(err.statusCode).send({
        success: false,
        message: err.message,
        code: err.code,
      });
    }
    request.server.log.error(err);
    return reply.code(500).send({ success: false, message: 'TTS failed' });
  }
}

export async function getAgentConversation(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  if (!workspaceId) {
    return reply.code(401).send({ success: false, message: 'Workspace required' });
  }
  const { id: agentId, conversationId } = request.params as {
    id: string;
    conversationId: string;
  };

  const conversation = await request.server.prisma.agentChatConversation.findFirst({
    where: { id: conversationId, workspaceId, agentId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!conversation) {
    return reply.code(404).send({ success: false, message: 'Conversation not found' });
  }

  return reply.send({ success: true, data: conversation });
}

export async function getAgentRetrievalStats(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  if (!workspaceId) {
    return reply.code(401).send({ success: false, message: 'Workspace required' });
  }
  const { id: agentId } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, agentId);
  if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

  const stats = await getRetrievalStats(request.server, workspaceId, agentId);
  return reply.send({ success: true, data: stats });
}

export async function getAgentTokenStats(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  if (!workspaceId) {
    return reply.code(401).send({ success: false, message: 'Workspace required' });
  }
  const { id: agentId } = request.params as { id: string };

  const month = new Date().toISOString().substring(0, 7);
  const monthStart = new Date(`${month}-01`);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

  const [totalUsage, cacheHits, conversations] = await Promise.all([
    request.server.prisma.tokenUsageLog.aggregate({
      where: {
        agentId,
        workspaceId,
        createdAt: { gte: monthStart, lt: monthEnd },
      },
      _sum: { totalTokens: true, costInr: true },
      _count: true,
    }),
    request.server.prisma.tokenUsageLog.count({
      where: {
        agentId,
        workspaceId,
        fromCache: true,
        createdAt: { gte: monthStart },
      },
    }),
    request.server.prisma.agentChatConversation.count({
      where: {
        agentId,
        workspaceId,
        createdAt: { gte: monthStart },
      },
    }),
  ]);

  const totalCalls = totalUsage._count;
  const cacheSavedCalls = cacheHits;
  const cacheSavingsPercent =
    totalCalls > 0
      ? Math.round((cacheSavedCalls / (totalCalls + cacheSavedCalls)) * 100)
      : 0;

  return reply.send({
    success: true,
    data: {
      totalTokens: totalUsage._sum.totalTokens || 0,
      totalCostInr: totalUsage._sum.costInr || 0,
      totalConversations: conversations,
      cacheHits: cacheSavedCalls,
      cacheSavingsPercent,
      avgTokensPerConversation:
        conversations > 0
          ? Math.round((totalUsage._sum.totalTokens || 0) / conversations)
          : 0,
    },
  });
}

export async function testAgent(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const body = request.body as AgentTestBody;

  try {
    return await testAgentChat({
      workspaceId,
      agentId: id,
      message: body.message,
      conversationHistory: body.conversationHistory,
    });
  } catch (err) {
    if (err instanceof AgentTestError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    if (err instanceof OpenAiProviderError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    throw err;
  }
}
