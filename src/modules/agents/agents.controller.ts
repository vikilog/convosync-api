import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { getJwtUser } from '../../middleware/auth.js';
import { scopedUpdateData } from '../../middleware/workspaceScope.js';
import { DEFAULT_AGENT_ACTIONS } from '../../constants/agent-actions.js';
import { assertAiAgentCreateAllowed, PlanGateError } from '../../services/planUsageGuards.js';
import { withSimilarityLowThreshold } from '../ai-agent/hybrid/similarity-threshold.js';
import type { AgentCreateBody, ProfileUpdateBody } from '../../routes/agents.schemas.js';
import { DEFAULT_PROMPTS } from './agents.helpers.js';

export async function listAgents(request: FastifyRequest) {
  const { workspaceId } = getJwtUser(request);
  return prisma.aiAgent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAgent(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  return agent;
}

export async function createAgent(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const body = request.body as AgentCreateBody;
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
}

export async function updateAgent(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const body = request.body as ProfileUpdateBody;
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
}

export async function toggleAgent(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  await prisma.aiAgent.updateMany({
    where: { id, workspaceId },
    data: { isEnabled: !agent.isEnabled },
  });
  return prisma.aiAgent.findFirst({ where: { id, workspaceId } });
}

export async function duplicateAgent(request: FastifyRequest, reply: FastifyReply) {
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
}

export async function deleteAgent(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await prisma.aiAgent.findFirst({ where: { id, workspaceId } });
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  await prisma.aiAgent.deleteMany({ where: { id, workspaceId } });
  return { success: true };
}
