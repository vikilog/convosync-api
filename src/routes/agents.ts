import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth, scopedUpdateData } from '../middleware/workspaceScope.js';
import { AgentTestError, testAgentChat } from '../services/agent-test.service.js';
import { OpenAiProviderError } from '../modules/ai-chat/providers/openai.provider.js';
import { ConversationService } from '../modules/ai-agent/conversation.service.js';
import { UrlFetchError, fetchUrlKnowledge } from '../services/url-fetch.service.js';
import { DEFAULT_AGENT_ACTIONS } from '../constants/agent-actions.js';
import { assertAiAgentCreateAllowed } from '../services/planUsageGuards.js';

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
  flowDefinition: z.record(z.unknown()).optional(),
});

const skillCreateSchema = z.object({
  title: z.string().min(1).max(200),
  trigger: z.string().default(''),
  instructions: z.string().default(''),
});

const skillUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  trigger: z.string().optional(),
  instructions: z.string().optional(),
  status: z.enum(['draft', 'live']).optional(),
});

const knowledgeCreateSchema = z.object({
  type: z.enum(['document', 'online_data', 'qna', 'attachment']),
  title: z.string().min(1).max(200),
  content: z.string().optional(),
  url: z.string().url().optional().or(z.literal('')),
  fileUrl: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
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

    const updateData: Record<string, unknown> = { ...body };
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
        tenantId: z.string().optional(),
        channel: z.string().optional(),
      })
      .parse(request.body ?? {});

    const agent = await getAgentOr404(workspaceId, agentId);
    if (!agent) return reply.code(404).send({ success: false, message: 'Agent not found' });

    const conversationService = new ConversationService(fastify);

    try {
      const result = await conversationService.chat({
        workspaceId: body.tenantId ?? workspaceId,
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

  fastify.get('/:id/token-stats', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) {
      return reply.code(401).send({ success: false, message: 'Workspace required' });
    }
    const { id: agentId } = request.params as { id: string };
    const query = request.query as { tenantId?: string };
    const scopedWorkspaceId = query.tenantId || workspaceId;

    const month = new Date().toISOString().substring(0, 7);
    const monthStart = new Date(`${month}-01`);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);

    const [totalUsage, cacheHits, conversations] = await Promise.all([
      fastify.prisma.tokenUsageLog.aggregate({
        where: {
          agentId,
          workspaceId: scopedWorkspaceId,
          createdAt: { gte: monthStart, lt: monthEnd },
        },
        _sum: { totalTokens: true, costInr: true },
        _count: true,
      }),
      fastify.prisma.tokenUsageLog.count({
        where: {
          agentId,
          workspaceId: scopedWorkspaceId,
          fromCache: true,
          createdAt: { gte: monthStart },
        },
      }),
      fastify.prisma.agentChatConversation.count({
        where: {
          agentId,
          workspaceId: scopedWorkspaceId,
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
    const skill = await prisma.aiSkill.create({
      data: { agentId: id, ...body },
    });
    return reply.code(201).send(skill);
  });

  fastify.put('/:id/skills/:skillId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, skillId } = request.params as { id: string; skillId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const body = skillUpdateSchema.parse(request.body ?? {});
    const existing = await prisma.aiSkill.findFirst({ where: { id: skillId, agentId: id } });
    if (!existing) return reply.code(404).send({ error: 'Skill not found' });
    return prisma.aiSkill.update({ where: { id: skillId }, data: body });
  });

  fastify.patch('/:id/skills/:skillId/publish', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, skillId } = request.params as { id: string; skillId: string };
    const agent = await getAgentOr404(workspaceId, id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const existing = await prisma.aiSkill.findFirst({ where: { id: skillId, agentId: id } });
    if (!existing) return reply.code(404).send({ error: 'Skill not found' });
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
      return await fetchUrlKnowledge({
        agentId: id,
        workspaceId,
        url: body.url,
        refreshInterval: body.refreshInterval,
      });
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
    return reply.code(201).send(item);
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
    await prisma.aiAgentKnowledgeItem.delete({ where: { id: kId } });
    return { success: true };
  });
}
