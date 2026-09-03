import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  campaignScheduleDelayMs,
  cancelScheduledCampaignBroadcast,
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

// Whitelists + type-checks the fields campaignBroadcast.service.ts actually
// consumes from this client-controlled JSON blob — anything else is silently
// stripped by zod's default object parsing rather than stored verbatim.
const audienceFilterSchema = z.object({
  channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
  segmentId: z.string().optional(),
  segmentIds: z.array(z.string()).optional(),
  tag: z.string().optional(),
  /** 'any' = union (OR) · 'all' = intersection (AND) — see campaignAudienceFilter.ts. */
  tagMatchMode: z.enum(['any', 'all']).optional(),
  variableMappings: z.record(z.string()).optional(),
  headerMediaStorageKey: z.string().optional(),
  headerMediaMimeType: z.string().optional(),
  headerMediaFileName: z.string().optional(),
  headerMediaAssetId: z.string().optional(),
  /** How a recipient's reply to this campaign should be routed — see campaignReplyRouting.service.ts. */
  replyHandling: z.enum(['default', 'journey', 'ai_agent']).optional(),
  replyJourneyId: z.string().optional(),
  replyAgentId: z.string().optional(),
});

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
      name: z.string().trim().min(1),
      templateId: z.string().min(1),
      channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
      audienceType: z.enum(['all', 'segment', 'tag', 'csv']),
      audienceFilter: audienceFilterSchema.optional(),
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
      // A past/near-past scheduledAt previously fell through to a silent
      // 'draft' with the stale date stored anyway — reject it explicitly,
      // matching how PATCH already treats this same input.
      if (campaignScheduleDelayMs(scheduledAt) <= 0) {
        return reply.code(400).send({ error: 'scheduledAt must be in the future' });
      }
    }

    const isScheduled = Boolean(scheduledAt);
    let totalRecipients: number;
    try {
      totalRecipients = await countCampaignAudienceFromFilter(
        workspaceId,
        body.audienceType,
        audienceFilter
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid audience filter';
      return reply.code(400).send({ error: message });
    }
    if (totalRecipients === 0) {
      return reply.code(400).send({ error: 'Audience is empty — no contacts match this filter' });
    }

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
          campaignScheduleDelayMs(scheduledAt)
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

  // Full edit of a draft, or a scheduled campaign while more than 10 minutes before send.
  fastify.patch('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const schema = z
      .object({
        name: z.string().trim().min(1).optional(),
        templateId: z.string().min(1).optional(),
        channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
        audienceType: z.enum(['all', 'segment', 'tag', 'csv']).optional(),
        audienceFilter: audienceFilterSchema.optional(),
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

    // 'failed' isn't covered by isScheduledCampaignEditable (that guard is
    // specifically about editing a still-pending schedule) — a failed
    // campaign is separately always editable, to let the user fix whatever
    // caused the failure and relaunch it.
    if (!isScheduledCampaignEditable(campaign.status, campaign.scheduledAt) && campaign.status !== 'failed') {
      // 'draft' is always editable, so only a 'scheduled' campaign inside its
      // 10-minute send-lock window, or another terminal status, lands here.
      return reply.code(409).send({
        error:
          campaign.status === 'scheduled'
            ? 'Can only edit when more than 10 minutes before send'
            : `Campaign is ${campaign.status} — not editable`,
      });
    }

    // Relaunching a failed campaign that was never scheduled (sent
    // immediately) shouldn't be forced through the scheduling path — the
    // caller follows up with POST /:id/send. If scheduledAt is given (or the
    // campaign already had one — a failed *scheduled* send), fall through to
    // the normal reschedule path below instead.
    const relaunchWithoutSchedule =
      campaign.status === 'failed' && body.scheduledAt === undefined && !campaign.scheduledAt;

    let nextScheduledAt = campaign.scheduledAt;
    if (!relaunchWithoutSchedule) {
      if (body.scheduledAt !== undefined) {
        const scheduledAt = new Date(body.scheduledAt);
        if (Number.isNaN(scheduledAt.getTime())) {
          return reply.code(400).send({ error: 'Invalid scheduledAt' });
        }
        nextScheduledAt = scheduledAt;
      }
      // Required either way — a draft has no existing scheduledAt to fall back
      // on, so skipping this check let a draft PATCHed without a new
      // scheduledAt silently schedule for "now" via a 0ms enqueue delay below.
      if (!nextScheduledAt || campaignScheduleDelayMs(nextScheduledAt) <= 0) {
        return reply.code(400).send({ error: 'scheduledAt must be in the future' });
      }
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
    const nextTemplateId = body.templateId ?? campaign.templateId;
    if (!nextTemplateId) {
      return reply.code(400).send({ error: 'Select a template before scheduling' });
    }
    const filterForCount = nextFilter ?? prevFilter;
    let totalRecipients: number;
    try {
      totalRecipients = await countCampaignAudienceFromFilter(
        workspaceId,
        nextAudienceType,
        filterForCount
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid audience filter';
      return reply.code(400).send({ error: message });
    }
    if (totalRecipients === 0) {
      return reply.code(400).send({ error: 'Audience is empty — no contacts match this filter' });
    }

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.templateId !== undefined ? { templateId: body.templateId } : {}),
        ...(body.audienceType !== undefined ? { audienceType: body.audienceType } : {}),
        ...(nextFilter !== undefined
          ? { audienceFilter: Object.keys(nextFilter).length ? (nextFilter as object) : undefined }
          : {}),
        totalRecipients,
        ...(relaunchWithoutSchedule
          ? { lastError: null }
          : { scheduledAt: nextScheduledAt, status: 'scheduled' }),
      },
    });

    if (relaunchWithoutSchedule) {
      return updated;
    }

    try {
      await enqueueCampaignBroadcast(
        { campaignId: id, workspaceId },
        campaignScheduleDelayMs(nextScheduledAt as Date)
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

  fastify.post('/:id/cancel', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) return reply.code(404).send({ error: 'Not found' });

    if (campaign.status === 'scheduled') {
      await cancelScheduledCampaignBroadcast(id);
      const updated = await prisma.campaign.updateMany({
        where: { id, workspaceId, status: 'scheduled' },
        data: { status: 'cancelled' },
      });
      if (updated.count === 0) {
        return reply.code(409).send({ error: 'Campaign is no longer scheduled' });
      }
      return { ok: true, status: 'cancelled' };
    }

    if (campaign.status === 'running') {
      // The send loop polls for status !== 'running' every
      // CAMPAIGN_PROGRESS_CHECK_INTERVAL contacts and stops early there,
      // preserving whatever it already sent — this does not stop instantly.
      // It also overwrites this status with the same 'cancelled' value once
      // it actually stops, so setting it directly here (rather than a
      // transient "cancelling") is enough for the loop to notice.
      const updated = await prisma.campaign.updateMany({
        where: { id, workspaceId, status: 'running' },
        data: { status: 'cancelled' },
      });
      if (updated.count === 0) {
        return reply.code(409).send({ error: 'Campaign is no longer running' });
      }
      return { ok: true, status: 'cancelled' };
    }

    return reply.code(409).send({ error: `Campaign is ${campaign.status} — nothing to cancel` });
  });

  // Re-arms a paused (cancelled) campaign at its original scheduledAt — only
  // possible while that time is still in the future; a lapsed schedule needs
  // a fresh scheduledAt via PATCH instead of a blind resume.
  fastify.post('/:id/resume', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) return reply.code(404).send({ error: 'Not found' });

    if (campaign.status !== 'cancelled') {
      return reply.code(409).send({ error: `Campaign is ${campaign.status} — nothing to resume` });
    }
    if (!campaign.scheduledAt || campaignScheduleDelayMs(campaign.scheduledAt) <= 0) {
      return reply.code(409).send({
        error: 'Original send time has already passed — edit the campaign to set a new time first.',
      });
    }

    const updated = await prisma.campaign.updateMany({
      where: { id, workspaceId, status: 'cancelled' },
      data: { status: 'scheduled' },
    });
    if (updated.count === 0) {
      return reply.code(409).send({ error: 'Campaign is no longer cancelled' });
    }

    try {
      await enqueueCampaignBroadcast(
        { campaignId: id, workspaceId },
        campaignScheduleDelayMs(campaign.scheduledAt)
      );
    } catch (err) {
      await prisma.campaign.update({ where: { id }, data: { status: 'cancelled' } });
      request.log.error({ err, campaignId: id }, 'Failed to re-enqueue resumed campaign');
      return reply.code(502).send({ error: 'Could not resume — scheduling queue failed. Try again.' });
    }

    return { ok: true, status: 'scheduled' };
  });

  const DELETE_SEND_LOCK_MS = 2 * 60 * 1000;

  fastify.delete('/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const campaign = await prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) return reply.code(404).send({ error: 'Not found' });

    if (campaign.status === 'running') {
      return reply.code(409).send({ error: 'Cannot delete a campaign that is currently sending' });
    }

    if (campaign.status === 'scheduled') {
      const msUntilSend = campaign.scheduledAt ? campaign.scheduledAt.getTime() - Date.now() : Infinity;
      if (msUntilSend < DELETE_SEND_LOCK_MS) {
        return reply.code(409).send({
          error: 'Too close to send time to delete — pause it first, or wait for it to complete.',
        });
      }
      // Drop the queued job so it doesn't fire against a now-deleted campaign.
      await cancelScheduledCampaignBroadcast(id);
    }

    await prisma.campaign.delete({ where: { id } });
    return { ok: true };
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
