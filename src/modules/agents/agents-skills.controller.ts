import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { getJwtUser } from '../../middleware/auth.js';
import {
  skillCreateSchema,
  type SkillCreateBody,
  type SkillUpdateBody,
} from '../../routes/agents.schemas.js';
import { getAgentOr404, resolveSkillKnowledgeIds } from './agents.helpers.js';

export async function listSkills(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  return prisma.aiSkill.findMany({
    where: { agentId: id },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createSkill(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const body = request.body as SkillCreateBody;
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
}

// Per-row errors — do not fail the whole batch
export async function bulkCreateSkills(request: FastifyRequest, reply: FastifyReply) {
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
}

export async function updateSkill(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, skillId } = request.params as { id: string; skillId: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const body = request.body as SkillUpdateBody;
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
}

export async function publishSkill(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, skillId } = request.params as { id: string; skillId: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const existing = await prisma.aiSkill.findFirst({ where: { id: skillId, agentId: id } });
  if (!existing) return reply.code(404).send({ error: 'Skill not found' });
  // Empty trigger is allowed — do not block publish
  return prisma.aiSkill.update({ where: { id: skillId }, data: { status: 'live' } });
}

export async function deleteSkill(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, skillId } = request.params as { id: string; skillId: string };
  const agent = await getAgentOr404(workspaceId, id);
  if (!agent) return reply.code(404).send({ error: 'Not found' });
  const existing = await prisma.aiSkill.findFirst({ where: { id: skillId, agentId: id } });
  if (!existing) return reply.code(404).send({ error: 'Skill not found' });
  await prisma.aiSkill.delete({ where: { id: skillId } });
  return { success: true };
}
