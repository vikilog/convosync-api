import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';

/**
 * Dashboard-side settings for the embeddable AI chat widget: one row per
 * workspace, auto-provisioned on first access. The public chat endpoint that
 * the embedded script actually talks to lives in webWidgetPublic.ts.
 */

function generateToken(): string {
  return `wgt_${randomBytes(24).toString('hex')}`;
}

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  botName: z.string().trim().min(1).max(60).optional(),
  greeting: z.string().trim().min(1).max(300).optional(),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #16a34a')
    .optional(),
  agentId: z.string().min(1).nullable().optional(),
});

function serialize(row: {
  token: string;
  enabled: boolean;
  botName: string;
  greeting: string;
  accentColor: string;
  agentId: string | null;
  updatedAt: Date;
}) {
  return {
    token: row.token,
    enabled: row.enabled,
    botName: row.botName,
    greeting: row.greeting,
    accentColor: row.accentColor,
    agentId: row.agentId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getOrCreateWidget(workspaceId: string) {
  const existing = await prisma.webWidget.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  return prisma.webWidget.create({ data: { workspaceId, token: generateToken() } });
}

export default async function webWidgetRoutes(fastify: FastifyInstance) {
  fastify.get('/', companyAuth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const widget = await getOrCreateWidget(workspaceId);
    return { item: serialize(widget) };
  });

  fastify.put('/', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = updateSchema.parse(request.body ?? {});

    if (body.agentId) {
      const agent = await prisma.aiAgent.findFirst({
        where: { id: body.agentId, workspaceId },
        select: { id: true, category: true },
      });
      if (!agent) return reply.code(404).send({ error: 'Agent not found' });
      if (agent.category !== 'ai_agent') {
        return reply.code(400).send({ error: 'Only AI agents can power the website widget.' });
      }
    }

    await getOrCreateWidget(workspaceId);
    const widget = await prisma.webWidget.update({
      where: { workspaceId },
      data: body,
    });
    return { item: serialize(widget) };
  });

  fastify.post('/regenerate-token', companyAuth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    await getOrCreateWidget(workspaceId);
    const widget = await prisma.webWidget.update({
      where: { workspaceId },
      data: { token: generateToken() },
    });
    return { item: serialize(widget) };
  });
}
