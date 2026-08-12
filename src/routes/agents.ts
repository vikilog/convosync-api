import { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth, scopedUpdateData } from '../middleware/workspaceScope.js';
import { AgentTestError, testAgentChat } from '../services/agent-test.service.js';
import { OpenAiProviderError } from '../modules/ai-chat/providers/openai.provider.js';
import { ConversationService } from '../modules/ai-agent/conversation.service.js';
import { UrlFetchError, fetchUrlKnowledge } from '../services/url-fetch.service.js';
import { indexKnowledgeItemInBackground, knowledgeIndexService } from '../modules/ai-agent/knowledge/knowledge-index.service.js';
import { invalidateWorkspaceCache } from '../modules/ai-agent/hybrid/redis-cache.js';
import { getRetrievalStats } from '../modules/ai-agent/hybrid/analytics.js';
import { DEFAULT_AGENT_ACTIONS } from '../constants/agent-actions.js';
import { assertAiAgentCreateAllowed, PlanGateError } from '../services/planUsageGuards.js';
import {
  PreviewSttError,
  synthesizePreviewSpeech,
  transcribePreviewAudio,
} from '../services/preview-stt.service.js';
import { withSimilarityLowThreshold } from '../modules/ai-agent/hybrid/similarity-threshold.js';
const AGENT_CATEGORY = z.enum(['ai_agent', 'responsive', 'rule_based']);
const INTENT_FALLBACK = z.enum(['silent', 'automated_response', 'transfer_human']);

const profileUpdateSchema = z.object({
  name: z.string().min(1).max(250).optional(),
  description: z.string().max(500).nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  welcomeMessageEnabled: z.boolean().optional(),
  welcomeMessageText: z.string().max(1000).nullable().optional(),
  intentFallback: INTENT_FALLBACK.optional(),
  conversationCloseWaitMins: z.number().int().min(1).max(10).optional(),
  systemPrompt: z.string().optional(),
  instructions: z.string().max(5000).nullable().optional(),
  toneOfVoice: z.enum(['professional', 'humorous', 'casual', 'friendly']).optional(),
  fallbackLanguage: z
    .enum(['english', 'hindi', 'hinglish', 'spanish', 'arabic', 'french'])
    .optional(),
  brandBackground: z.string().max(1200).nullable().optional(),
  actions: z
    .array(
      z.object({
        type: z.enum([
          'close_conversations',
          'escalate_to_human',
          'add_contact_tags',
          'update_contact_attributes',
        ]),
        enabled: z.boolean(),
        instruction: z.string().max(1000),
      })
    )
    .optional(),
  isPublished: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  voiceAgentEnabled: z.boolean().optional(),
  voiceSttProvider: z.string().min(1).optional(),
  voiceTtsProvider: z.string().min(1).optional(),
  voiceTtsVoiceId: z.string().min(1).nullable().optional(),
  /** Knowledge match / escalate low bar (0–1). null clears override → env default. */
  similarityLowThreshold: z.number().min(0).max(1).nullable().optional(),
  flowDefinition: z.record(z.unknown()).optional(),
});

const skillCreateSchema = z.object({
  title: z.string().min(1).max(200),
  trigger: z.string().default(''),
  instructions: z.string().default(''),
  description: z.string().max(500).nullable().optional(),
  knowledgeItemIds: z.array(z.string().min(1)).optional(),
  status: z.enum(['draft', 'live']).optional(),
});

const skillUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  trigger: z.string().optional(),
  instructions: z.string().optional(),
  description: z.string().max(500).nullable().optional(),
  knowledgeItemIds: z.array(z.string().min(1)).optional(),
  status: z.enum(['draft', 'live']).optional(),
});

/** Dedupe + ensure every id belongs to this agent. Throws Zod-style Error message. */
async function resolveSkillKnowledgeIds(
  agentId: string,
  ids: string[] | undefined
): Promise<string[]> {
  const deduped = [...new Set((ids ?? []).filter(Boolean))];
  if (deduped.length === 0) return [];
  const found = await prisma.aiAgentKnowledgeItem.findMany({
    where: { agentId, id: { in: deduped } },
    select: { id: true },
  });
  if (found.length !== deduped.length) {
    const ok = new Set(found.map((r) => r.id));
    const bad = deduped.filter((id) => !ok.has(id));
    throw new Error(`Invalid knowledgeItemIds for this agent: ${bad.join(', ')}`);
  }
  return deduped;
}

const knowledgeCreateSchema = z.object({
  type: z.enum(['document', 'online_data', 'qna', 'attachment']),
  title: z.string().min(1).max(200),
  content: z.string().optional(),
  url: z.string().url().optional().or(z.literal('')),
  fileUrl: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const knowledgeUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().nullable().optional(),
  url: z.string().url().optional().or(z.literal('')).nullable(),
  fileUrl: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(['ready', 'processing', 'failed']).optional(),
});

async function getAgentOr404(workspaceId: string, id: string) {
  return prisma.aiAgent.findFirst({ where: { id, workspaceId } });
}

const DEFAULT_PROMPTS: Record<z.infer<typeof AGENT_CATEGORY>, string> = {
  ai_agent:
    'Configure agent behavior through system instructions for personalized and scenario-specific automation.',
  responsive:
    "Triggered by the client's inbound messages, ideal for solving questions in real time.",
  rule_based: 'No AI, just simple flow-based behavior, ideal for routine tasks.',
};

export default async function agentRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  await fastify.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  });

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return prisma.aiAgent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return agent;
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const schema = z.object({
      name: z.string().min(1),
      category: AGENT_CATEGORY.default('ai_agent'),
      role: z
        .enum(['lead_acquisition', 'customer_service', 'shop_assistant', 'custom'])
        .optional(),
      systemPrompt: z.string().optional(),
      captureFields: z.array(z.string()).optional(),
      escalationRules: z.record(z.unknown()).optional(),
    });
    const body = schema.parse(request.body);
    try {
      await assertAiAgentCreateAllowed(workspaceId);
    } catch (err) {
      if (err instanceof PlanGateError) {
        return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
      }
      const message = err instanceof Error ? err.message : 'AI agent limit reached';
      return reply.code(400).send({ error: message });
    }
    const defaultDescription = DEFAULT_PROMPTS[body.category];
    const agent = await prisma.aiAgent.create({
      data: {
        name: body.name,
        role: body.role ?? 'custom',
        category: body.category,
        description: defaultDescription,
        systemPrompt: body.systemPrompt ?? defaultDescription,
        actions: DEFAULT_AGENT_ACTIONS,
        captureFields: body.captureFields ?? [],
        escalationRules: body.escalationRules as object | undefined,
        flowsCount: body.category === 'rule_based' ? 1 : 1,
        flowDefinition:
          body.category === 'rule_based'
            ? {
                name: `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}FLOW`,
                status: 'inactive',
                triggerType: null,
                keywordMatchRule: 'containing',
                keywordList: [],
                nodes: [],
              }
            : undefined,
        workspaceId,
      },
    });
    return reply.code(201).send(agent);
  });

  fastify.put('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = profileUpdateSchema.parse(request.body ?? {});
    const existing = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const { similarityLowThreshold, ...rest } = body;
    const updateData: Record<string, unknown> = { ...rest };
    if (similarityLowThreshold !== undefined) {
      // 1.0 disables vector RAG in practice — store as unset (env default).
      const normalized =
        similarityLowThreshold != null && similarityLowThreshold >= 1
          ? null
          : similarityLowThreshold;
      updateData.escalationRules = withSimilarityLowThreshold(
        existing.escalationRules,
        normalized
      );
    }
    if (body.isPublished === true && !existing.isPublished) {
      updateData.publishedAt = new Date();
      updateData.isEnabled = body.isEnabled ?? true;
    } else if (body.isPublished === false) {
      updateData.publishedAt = null;
    }

    await prisma.aiAgent.updateMany({
      where: { id, workspaceId },
      data: scopedUpdateData(updateData),
    });
    return prisma.aiAgent.findFirst({ where: { id, workspaceId } });
  });

  fastify.post('/:id/toggle', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    await prisma.aiAgent.updateMany({
      where: { id, workspaceId },
      data: { isEnabled: !agent.isEnabled },
    });
    return prisma.aiAgent.findFirst({ where: { id, workspaceId } });
  });

  fastify.post('/:id/duplicate', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    try {
      await assertAiAgentCreateAllowed(workspaceId);
    } catch (err) {
      if (err instanceof PlanGateError) {
        return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
      }
      const message = err instanceof Error ? err.message : 'AI agent limit reached';
      return reply.code(400).send({ error: message });
    }

    const copy = await prisma.aiAgent.create({
      data: {
        name: `${agent.name} (Copy)`,
        role: agent.role,
        category: agent.category,
        description: agent.description,
        toneOfVoice: agent.toneOfVoice,
        fallbackLanguage: agent.fallbackLanguage,
        instructions: agent.instructions,
        brandBackground: agent.brandBackground,
        actions: agent.actions ?? DEFAULT_AGENT_ACTIONS,
        isPublished: false,
        publishedAt: null,
        systemPrompt: agent.systemPrompt,
        knowledgeBase: agent.knowledgeBase ?? undefined,
        captureFields: agent.captureFields,
        escalationRules: agent.escalationRules ?? undefined,
        avatarUrl: agent.avatarUrl,
        welcomeMessageEnabled: agent.welcomeMessageEnabled,
        welcomeMessageText: agent.welcomeMessageText,
        intentFallback: agent.intentFallback,
        conversationCloseWaitMins: agent.conversationCloseWaitMins,
        flowDefinition: agent.flowDefinition ?? undefined,
        isEnabled: false,
        voiceAgentEnabled: agent.voiceAgentEnabled,
        voiceSttProvider: agent.voiceSttProvider,
        voiceTtsProvider: agent.voiceTtsProvider,
        voiceTtsVoiceId: agent.voiceTtsVoiceId,
        flowsCount: agent.flowsCount,
        workspaceId,
      },
    });
    return reply.code(201).send(copy);
  });

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    await prisma.aiAgent.deleteMany({ where: { id, workspaceId } });
    return { success: true };
  });

  fastify.post('/:id/chat', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) {
      return reply.code(401).send({ success: false, message: 'Workspace required' });
    }
    const { id: agentId } = request.params as { id: string };
    const body = z
      .object({
        message: z.string().min(1).max(4000),
        conversationId: z.string().optional(),
        channel: z.string().optional(),
      })
      .parse(request.body ?? {});

    const agent = await getAgentOr404(workspaceId, agentId);
    if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

    const conversationService = new ConversationService(fastify);

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
      fastify.log.error(error);
      return reply.status(500).send({ success: false, message });
    }
  });

  /** Voice preview: MediaRecorder blob → agent's STT provider → text */
  fastify.post('/:id/voice-preview/stt', auth, async (request, reply) => {
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
      fastify.log.error(err);
      return reply.code(500).send({ success: false, message: 'STT failed' });
    }
  });

  /** Voice preview: text → agent's TTS provider → audio bytes */
  fastify.post('/:id/voice-preview/tts', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) {
      return reply.code(401).send({ success: false, message: 'Workspace required' });
    }
    const { id: agentId } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, agentId);
    if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

    const body = request.body as { text?: string };
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
      fastify.log.error(err);
      return reply.code(500).send({ success: false, message: 'TTS failed' });
    }
  });

  fastify.get('/:id/conversations/:conversationId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) {
      return reply.code(401).send({ success: false, message: 'Workspace required' });
    }
    const { id: agentId, conversationId } = request.params as {
      id: string;
      conversationId: string;
    };

    const conversation = await fastify.prisma.agentChatConversation.findFirst({
      where: { id: conversationId, workspaceId, agentId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!conversation) {
      return reply.code(404).send({ success: false, message: 'Conversation not found' });
    }

    return reply.send({ success: true, data: conversation });
  });

  fastify.get('/:id/retrieval-stats', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) {
      return reply.code(401).send({ success: false, message: 'Workspace required' });
    }
    const { id: agentId } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, agentId);
    if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

    const stats = await getRetrievalStats(fastify, workspaceId, agentId);
    return reply.send({ success: true, data: stats });
  });

  fastify.get('/:id/token-stats', auth, async (request, reply) => {
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
      fastify.prisma.tokenUsageLog.aggregate({
        where: {
          agentId,
          workspaceId,
          createdAt: { gte: monthStart, lt: monthEnd },
        },
        _sum: { totalTokens: true, costInr: true },
        _count: true,
      }),
      fastify.prisma.tokenUsageLog.count({
        where: {
          agentId,
          workspaceId,
          fromCache: true,
          createdAt: { gte: monthStart },
        },
      }),
      fastify.prisma.agentChatConversation.count({
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
  });

  fastify.post('/:id/test', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = z
      .object({
        message: z.string().min(1).max(4000),
        conversationHistory: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string(),
            })
          )
          .default([]),
      })
      .parse(request.body ?? {});

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
  });

  // Skills
  fastify.get('/:id/skills', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return prisma.aiSkill.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.post('/:id/skills', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const body = skillCreateSchema.parse(request.body ?? {});
    let knowledgeItemIds: string[];
    try {
      knowledgeItemIds = await resolveSkillKnowledgeIds(id, body.knowledgeItemIds);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid knowledgeItemIds' });
    }
    const skill = await prisma.aiSkill.create({
      data: {
        agentId: id,
        title: body.title,
        trigger: body.trigger ?? '',
        instructions: body.instructions ?? '',
        description: body.description ?? null,
        knowledgeItemIds,
        status: body.status ?? 'draft',
      },
    });
    return reply.code(201).send(skill);
  });

  // Per-row errors — do not fail the whole batch
  fastify.post('/:id/skills/bulk', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });

    const rawBody = request.body ?? {};
    const skillsRaw = Array.isArray((rawBody as { skills?: unknown }).skills)
      ? (rawBody as { skills: unknown[] }).skills
      : null;
    if (!skillsRaw || skillsRaw.length === 0) {
      return reply.code(400).send({ error: 'skills array required (1–50 items)' });
    }
    if (skillsRaw.length > 50) {
      return reply.code(400).send({ error: 'Maximum 50 skills per bulk request' });
    }

    const results: Array<
      | { ok: true; index: number; skill: Awaited<ReturnType<typeof prisma.aiSkill.create>> }
      | { ok: false; index: number; error: string }
    > = [];

    for (let index = 0; index < skillsRaw.length; index++) {
      try {
        const row = skillCreateSchema.parse(skillsRaw[index] ?? {});
        const knowledgeItemIds = await resolveSkillKnowledgeIds(id, row.knowledgeItemIds);
        const skill = await prisma.aiSkill.create({
          data: {
            agentId: id,
            title: row.title,
            trigger: row.trigger ?? '',
            instructions: row.instructions ?? '',
            description: row.description ?? null,
            knowledgeItemIds,
            status: row.status ?? 'draft',
          },
        });
        results.push({ ok: true, index, skill });
      } catch (err) {
        const message =
          err instanceof z.ZodError
            ? err.errors.map((e) => e.message).join('; ')
            : err instanceof Error
              ? err.message
              : 'Failed to create skill';
        results.push({ ok: false, index, error: message });
      }
    }

    return {
      created: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });

  fastify.put('/:id/skills/:skillId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, skillId } = request.params as { id: string; skillId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const body = skillUpdateSchema.parse(request.body ?? {});
    const existing = await prisma.aiSkill.findFirst({ where: { id: skillId, agentId: id } });
    if (!existing) return reply.code(404).send({ error: 'Skill not found' });

    let knowledgeItemIds: string[] | undefined;
    if (body.knowledgeItemIds !== undefined) {
      try {
        knowledgeItemIds = await resolveSkillKnowledgeIds(id, body.knowledgeItemIds);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : 'Invalid knowledgeItemIds' });
      }
    }

    return prisma.aiSkill.update({
      where: { id: skillId },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(knowledgeItemIds !== undefined ? { knowledgeItemIds } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
    });
  });

  fastify.patch('/:id/skills/:skillId/publish', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, skillId } = request.params as { id: string; skillId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const existing = await prisma.aiSkill.findFirst({ where: { id: skillId, agentId: id } });
    if (!existing) return reply.code(404).send({ error: 'Skill not found' });
    // Empty trigger is allowed — do not block publish
    return prisma.aiSkill.update({ where: { id: skillId }, data: { status: 'live' } });
  });

  fastify.delete('/:id/skills/:skillId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, skillId } = request.params as { id: string; skillId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const existing = await prisma.aiSkill.findFirst({ where: { id: skillId, agentId: id } });
    if (!existing) return reply.code(404).send({ error: 'Skill not found' });
    await prisma.aiSkill.delete({ where: { id: skillId } });
    return { success: true };
  });

  // Knowledge
  fastify.get('/:id/knowledge', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return prisma.aiAgentKnowledgeItem.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
    });
  });

  // Single item (preview / reuse content)
  fastify.get('/:id/knowledge/:kId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, kId } = request.params as { id: string; kId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const item = await prisma.aiAgentKnowledgeItem.findFirst({
      where: { id: kId, agentId: id },
    });
    if (!item) return reply.code(404).send({ error: 'Knowledge item not found' });
    return item;
  });

  fastify.post('/:id/knowledge/fetch-url', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });

    const body = z
      .object({
        url: z.string().min(1),
        refreshInterval: z.enum(['daily', 'weekly', 'manual']).default('weekly'),
      })
      .parse(request.body ?? {});

    try {
      const result = await fetchUrlKnowledge({
        agentId: id,
        workspaceId,
        url: body.url,
        refreshInterval: body.refreshInterval,
      });
      void invalidateWorkspaceCache(fastify, workspaceId);
      return result;
    } catch (err) {
      if (err instanceof UrlFetchError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  fastify.post('/:id/knowledge', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const body = knowledgeCreateSchema.parse(request.body ?? {});
    const item = await prisma.aiAgentKnowledgeItem.create({
      data: {
        agentId: id,
        type: body.type,
        title: body.title,
        content: body.content,
        url: body.url || null,
        fileUrl: body.fileUrl,
        metadata: body.metadata as object | undefined,
        status: 'ready',
      },
    });
    void indexKnowledgeItemInBackground(workspaceId, item);
    void invalidateWorkspaceCache(fastify, workspaceId);
    return reply.code(201).send(item);
  });

  fastify.put('/:id/knowledge/:kId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, kId } = request.params as { id: string; kId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const existing = await prisma.aiAgentKnowledgeItem.findFirst({
      where: { id: kId, agentId: id },
    });
    if (!existing) return reply.code(404).send({ error: 'Knowledge item not found' });

    const body = knowledgeUpdateSchema.parse(request.body ?? {});
    const data: {
      title?: string;
      content?: string | null;
      url?: string | null;
      fileUrl?: string | null;
      metadata?: object;
      status?: string;
    } = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.content !== undefined) data.content = body.content;
    if (body.url !== undefined) data.url = body.url || null;
    if (body.fileUrl !== undefined) data.fileUrl = body.fileUrl;
    if (body.metadata !== undefined) data.metadata = body.metadata as object;
    if (body.status !== undefined) data.status = body.status;

    const contentChanged =
      (body.content !== undefined && body.content !== existing.content) ||
      (body.title !== undefined && body.title !== existing.title) ||
      (body.url !== undefined && (body.url || null) !== existing.url);

    const item = await prisma.aiAgentKnowledgeItem.update({
      where: { id: kId },
      data,
    });

    if (contentChanged) {
      await knowledgeIndexService.deleteItemVectors(workspaceId, kId);
      void indexKnowledgeItemInBackground(workspaceId, item);
    }
    void invalidateWorkspaceCache(fastify, workspaceId);
    return item;
  });

  fastify.delete('/:id/knowledge/:kId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, kId } = request.params as { id: string; kId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const existing = await prisma.aiAgentKnowledgeItem.findFirst({
      where: { id: kId, agentId: id },
    });
    if (!existing) return reply.code(404).send({ error: 'Knowledge item not found' });
    await knowledgeIndexService.deleteItemVectors(workspaceId, kId);
    await prisma.aiAgentKnowledgeItem.delete({ where: { id: kId } });
    void invalidateWorkspaceCache(fastify, workspaceId);
    return { success: true };
  });

  fastify.post('/:id/knowledge/reindex', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });

    const items = await prisma.aiAgentKnowledgeItem.findMany({
      where: { agentId: id, status: 'ready' },
      orderBy: { createdAt: 'asc' },
    });

    void invalidateWorkspaceCache(fastify, workspaceId);
    void (async () => {
      for (const item of items) {
        await indexKnowledgeItemInBackground(workspaceId, item);
      }
    })();

    return { queued: items.length };
  });
}
