import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { executeCampaignBroadcast } from '../services/campaignBroadcast.service.js';
import { getCampaignInsights } from '../services/campaignInsights.service.js';

export default async function campaignRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    return prisma.campaign.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  });

  fastify.get('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const detail = await getCampaignInsights(id, workspaceId);
    if (!detail) return reply.code(404).send({ error: 'Campaign not found' });
    return detail;
  });

  fastify.post('/', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const schema = z.object({
      name: z.string(),
      templateId: z.string().optional(),
      channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
      audienceType: z.enum(['all', 'segment', 'tag', 'csv']),
      audienceFilter: z.record(z.unknown()).optional(),
      scheduledAt: z.string().optional(),
    });
    const body = schema.parse(request.body);
    const audienceFilter = {
      ...(body.audienceFilter ?? {}),
      ...(body.channel ? { channel: body.channel } : {}),
    };
    const campaign = await prisma.campaign.create({
      data: {
        name: body.name,
        templateId: body.templateId,
        audienceType: body.audienceType,
        audienceFilter: Object.keys(audienceFilter).length ? (audienceFilter as object) : undefined,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        workspaceId,
      },
    });
    return reply.code(201).send(campaign);
  });

  fastify.post('/:id/send', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) return reply.code(404).send({ error: 'Not found' });

    try {
      const result = await executeCampaignBroadcast(id, workspaceId);
      return {
        message: 'Campaign broadcast completed',
        sentCount: result.sentCount,
        totalRecipients: result.totalRecipients,
      };
    } catch (err) {
      request.log.error({ err, campaignId: id }, 'Campaign send failed');
      return reply.code(502).send({
        error: err instanceof Error ? err.message : 'Campaign send failed',
      });
    }
  });
}
