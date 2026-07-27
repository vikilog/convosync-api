import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  campaignScheduleDelayMs,
  enqueueCampaignBroadcast,
} from '../queue/campaign-broadcast.queue.js';
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

    let scheduledAt: Date | undefined;
    if (body.scheduledAt) {
      scheduledAt = new Date(body.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        return reply.code(400).send({ error: 'Invalid scheduledAt' });
      }
    }

    const delayMs = campaignScheduleDelayMs(scheduledAt);
    const isScheduled = Boolean(scheduledAt) && delayMs > 0;

    const campaign = await prisma.campaign.create({
      data: {
        name: body.name,
        templateId: body.templateId,
        audienceType: body.audienceType,
        audienceFilter: Object.keys(audienceFilter).length ? (audienceFilter as object) : undefined,
        scheduledAt,
        status: isScheduled ? 'scheduled' : 'draft',
        workspaceId,
      },
    });

    if (isScheduled) {
      try {
        await enqueueCampaignBroadcast(
          { campaignId: campaign.id, workspaceId },
          delayMs
        );
      } catch (err) {
        request.log.error({ err, campaignId: campaign.id }, 'Failed to enqueue scheduled campaign');
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: 'failed' },
        });
        return reply.code(502).send({
          error: 'Campaign saved but scheduling queue failed. Try again or send now.',
          campaignId: campaign.id,
        });
      }
    }

    return reply.code(201).send(campaign);
  });

  fastify.post('/:id/send', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) return reply.code(404).send({ error: 'Not found' });

    if (campaign.status === 'running') {
      return reply.code(409).send({ error: 'Campaign is already running' });
    }
    if (campaign.status === 'completed') {
      return reply.code(409).send({ error: 'Campaign already completed' });
    }

    try {
      // Immediate send stays sync for wizard UX (sentCount in response).
      // Scheduled jobs use the BullMQ worker (same executeCampaignBroadcast).
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
