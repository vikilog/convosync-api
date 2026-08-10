import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  campaignScheduleDelayMs,
  enqueueCampaignBroadcast,
  isScheduledCampaignEditable,
} from '../queue/campaign-broadcast.queue.js';
import { countCampaignAudienceFromFilter } from '../services/campaign.service.js';
import { executeCampaignBroadcast } from '../services/campaignBroadcast.service.js';
import { getCampaignInsights } from '../services/campaignInsights.service.js';
import {
  resendAllCampaignFailed,
  resendCampaignRecipient,
} from '../services/campaignResend.service.js';

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
    const totalRecipients = await countCampaignAudienceFromFilter(
      workspaceId,
      body.audienceType,
      audienceFilter
    );

    const campaign = await prisma.campaign.create({
      data: {
        name: body.name,
        templateId: body.templateId,
        audienceType: body.audienceType,
        audienceFilter: Object.keys(audienceFilter).length ? (audienceFilter as object) : undefined,
        scheduledAt,
        status: isScheduled ? 'scheduled' : 'draft',
        totalRecipients,
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

  // Full edit of scheduled campaign while more than 10 minutes before send.
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const schema = z
      .object({
        name: z.string().trim().min(1).optional(),
        templateId: z.string().optional(),
        channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
        audienceType: z.enum(['all', 'segment', 'tag', 'csv']).optional(),
        audienceFilter: z.record(z.unknown()).optional(),
        scheduledAt: z.string().optional(),
      })
      .refine(
        (b) =>
          b.name !== undefined ||
          b.templateId !== undefined ||
          b.audienceType !== undefined ||
          b.audienceFilter !== undefined ||
          b.scheduledAt !== undefined,
        { message: 'Nothing to update' }
      );
    const body = schema.parse(request.body);

    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) return reply.code(404).send({ error: 'Not found' });

    if (!isScheduledCampaignEditable(campaign.status, campaign.scheduledAt)) {
      return reply.code(409).send({
        error: 'Can only edit when more than 10 minutes before send',
      });
    }

    let nextScheduledAt = campaign.scheduledAt;
    if (body.scheduledAt !== undefined) {
      const scheduledAt = new Date(body.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        return reply.code(400).send({ error: 'Invalid scheduledAt' });
      }
      const delayMs = campaignScheduleDelayMs(scheduledAt);
      if (delayMs <= 0) {
        return reply.code(400).send({ error: 'scheduledAt must be in the future' });
      }
      nextScheduledAt = scheduledAt;
    }

    const prevFilter =
      campaign.audienceFilter && typeof campaign.audienceFilter === 'object'
        ? (campaign.audienceFilter as Record<string, unknown>)
        : {};
    const nextFilter =
      body.audienceFilter !== undefined || body.channel !== undefined
        ? {
            ...prevFilter,
            ...(body.audienceFilter ?? {}),
            ...(body.channel ? { channel: body.channel } : {}),
          }
        : undefined;
    const nextAudienceType = body.audienceType ?? campaign.audienceType;
    const filterForCount = nextFilter ?? prevFilter;
    const totalRecipients = await countCampaignAudienceFromFilter(
      workspaceId,
      nextAudienceType,
      filterForCount
    );

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.templateId !== undefined ? { templateId: body.templateId } : {}),
        ...(body.audienceType !== undefined ? { audienceType: body.audienceType } : {}),
        ...(nextFilter !== undefined
          ? { audienceFilter: Object.keys(nextFilter).length ? (nextFilter as object) : undefined }
          : {}),
        scheduledAt: nextScheduledAt,
        status: 'scheduled',
        totalRecipients,
      },
    });

    try {
      await enqueueCampaignBroadcast(
        { campaignId: id, workspaceId },
        campaignScheduleDelayMs(nextScheduledAt)
      );
    } catch (err) {
      request.log.error({ err, campaignId: id }, 'Failed to re-enqueue scheduled campaign');
      return reply.code(502).send({
        error: 'Campaign updated but scheduling queue failed. Try again.',
        campaign: updated,
      });
    }

    return updated;
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

  fastify.post('/:id/resend-failed', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      const result = await resendAllCampaignFailed(id, workspaceId);
      return {
        message: 'Campaign failed recipients resent',
        ...result,
        resent: result.results.filter((r) => r.ok).length,
        failed: result.results.filter((r) => !r.ok).length,
      };
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 502;
      request.log.error({ err, campaignId: id }, 'Campaign resend-all failed');
      return reply.code(statusCode).send({
        error: err instanceof Error ? err.message : 'Campaign resend failed',
      });
    }
  });

  fastify.post('/:id/recipients/:messageId/resend', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, messageId } = request.params as { id: string; messageId: string };
    const detail = await getCampaignInsights(id, workspaceId);
    if (!detail) return reply.code(404).send({ error: 'Campaign not found' });

    try {
      const result = await resendCampaignRecipient(
        id,
        workspaceId,
        messageId,
        detail.channel === 'email' ? 'email' : 'whatsapp'
      );
      if (!result.ok) {
        return reply.code(502).send({
          error: result.error ?? 'Resend failed',
          ...result,
        });
      }
      return result;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 502;
      request.log.error({ err, campaignId: id, messageId }, 'Campaign recipient resend failed');
      return reply.code(statusCode).send({
        error: err instanceof Error ? err.message : 'Resend failed',
      });
    }
  });
}
