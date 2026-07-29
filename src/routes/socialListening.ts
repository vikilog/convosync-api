import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { replyToListeningComment } from '../services/instagramListening.service.js';
import {
  classifySocialCommentById,
  mapIntentToReviewLabel,
  mapStatusToReviewStatus,
  needsReviewQueue,
  SOCIAL_COMMENT_LOW_CONFIDENCE,
} from '../services/socialCommentClassify.service.js';
import {
  executeApproveAndSendDm,
  retryPrivateReplyDm,
} from '../services/socialCommentApproveDm.service.js';
import {
  getOrCreateSocialListeningSettings,
  updateSocialListeningSettings,
  validateSettingsPatch,
} from '../services/socialListeningSettings.service.js';
import {
  getDashboardStats,
  getIntentBreakdown,
  getNeedsAttention,
  getTopPosts,
  parseDashboardRange,
} from '../services/socialListeningDashboard.service.js';
import { listSocialListeningActivity } from '../services/socialListeningActivity.service.js';
import {
  getPostAutomationMap,
  getEffectivePostSettings,
  updatePostSettings,
} from '../services/socialListeningPostSetting.service.js';

export default async function socialListeningRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/settings', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const settings = await getOrCreateSocialListeningSettings(workspaceId);
    const skills = await prisma.aiSkill.findMany({
      where: { agent: { workspaceId }, status: 'live' },
      select: {
        id: true,
        title: true,
        agentId: true,
        agent: { select: { name: true } },
      },
      orderBy: { title: 'asc' },
      take: 200,
    });
    return {
      settings,
      dmSkillOptions: skills.map((s) => ({
        id: s.id,
        title: s.title,
        agentId: s.agentId,
        agentName: s.agent.name,
      })),
    };
  });

  fastify.patch('/settings', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = (request.body || {}) as Record<string, unknown>;
    const validated = validateSettingsPatch(body);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.error });
    }
    try {
      if (validated.data.dmAgentSkillId) {
        const skill = await prisma.aiSkill.findFirst({
          where: {
            id: validated.data.dmAgentSkillId,
            agent: { workspaceId },
          },
          select: { id: true },
        });
        if (!skill) {
          return reply.code(400).send({ error: 'dmAgentSkillId not found in this workspace' });
        }
      }
      const settings = await updateSocialListeningSettings(workspaceId, validated.data);
      return { settings };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get('/dashboard/stats', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { range?: string };
    const range = parseDashboardRange(query.range);
    return getDashboardStats(workspaceId, range);
  });

  fastify.get('/dashboard/intent-breakdown', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { range?: string };
    const range = parseDashboardRange(query.range);
    return getIntentBreakdown(workspaceId, range);
  });

  fastify.get('/dashboard/needs-attention', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : 25;
    return getNeedsAttention(workspaceId, Number.isFinite(limit) ? limit : 25);
  });

  fastify.get('/dashboard/activity', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : 30;
    const events = await listSocialListeningActivity(
      workspaceId,
      Number.isFinite(limit) ? limit : 30
    );
    return { events };
  });

  fastify.get('/dashboard/top-posts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { range?: string; limit?: string };
    const range = parseDashboardRange(query.range);
    const limit = query.limit ? Number(query.limit) : 8;
    return getTopPosts(workspaceId, range, Number.isFinite(limit) ? limit : 8);
  });

  /** Batch: agent on/off + funnel per post (missing = agent off). */
  fastify.get('/posts/automation', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { postIds?: string };
    const postIds = (query.postIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const posts = await getPostAutomationMap(workspaceId, postIds);
    return { posts };
  });

  fastify.get('/posts/:postId/settings', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { postId: rawPostId } = request.params as { postId: string };
    let postId = rawPostId;
    try {
      postId = decodeURIComponent(rawPostId);
    } catch {
      /* keep */
    }
    if (!postId.trim()) {
      return reply.code(400).send({ error: 'postId required' });
    }
    const settings = await getEffectivePostSettings(workspaceId, postId);
    const skills = await prisma.aiSkill.findMany({
      where: { agent: { workspaceId }, status: 'live' },
      select: {
        id: true,
        title: true,
        agentId: true,
        agent: { select: { name: true } },
      },
      orderBy: { title: 'asc' },
      take: 200,
    });
    return {
      settings,
      dmSkillOptions: skills.map((s) => ({
        id: s.id,
        title: s.title,
        agentId: s.agentId,
        agentName: s.agent.name,
      })),
    };
  });

  fastify.patch('/posts/:postId/settings', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { postId: rawPostId } = request.params as { postId: string };
    let postId = rawPostId;
    try {
      postId = decodeURIComponent(rawPostId);
    } catch {
      /* keep */
    }
    if (!postId.trim()) {
      return reply.code(400).send({ error: 'postId required' });
    }
    const body = (request.body || {}) as Record<string, unknown>;
    const validated = validateSettingsPatch(body);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.error });
    }
    try {
      if (validated.data.dmAgentSkillId) {
        const skill = await prisma.aiSkill.findFirst({
          where: {
            id: validated.data.dmAgentSkillId,
            agent: { workspaceId },
          },
          select: { id: true },
        });
        if (!skill) {
          return reply.code(400).send({ error: 'dmAgentSkillId not found in this workspace' });
        }
      }
      const settings = await updatePostSettings(workspaceId, postId, validated.data);
      return { success: true, settings };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      return reply.code(/not found/i.test(message) ? 404 : 400).send({ error: message });
    }
  });

  /** Review Queue — SocialComment rows with status=new (shared with Post Detail). */
  fastify.get('/comments', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { status?: string; postId?: string };

    // Hide the page's own comments/replies from the human review queue.
    const accounts = await prisma.instagramAccount.findMany({
      where: { workspaceId },
      select: { username: true, instagramUserId: true },
    });
    const ownUsernames = accounts
      .map((a) => a.username?.trim())
      .filter((n): n is string => Boolean(n));

    if (ownUsernames.length > 0 && (!query.status || query.status === 'new')) {
      await prisma.socialComment.updateMany({
        where: {
          workspaceId,
          status: 'new',
          OR: ownUsernames.map((n) => ({
            commenterUsername: { equals: n, mode: 'insensitive' as const },
          })),
        },
        data: { status: 'ignored', classificationStatus: 'classified' },
      });
    }

    const rows = await prisma.socialComment.findMany({
      where: {
        workspaceId,
        ...(query.postId ? { postId: query.postId } : {}),
        ...(query.status === 'all'
          ? {}
          : query.status
            ? { status: query.status }
            : { status: 'new' }),
        ...(ownUsernames.length > 0
          ? {
              NOT: {
                OR: ownUsernames.map((n) => ({
                  commenterUsername: { equals: n, mode: 'insensitive' as const },
                })),
              },
            }
          : {}),
      },
      orderBy: [{ commentedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });

    const comments = rows.map((r) => ({
      id: r.id,
      commentId: r.commentId,
      postId: r.postId,
      username: r.commenterUsername || 'instagram_user',
      profilePicUrl: r.commenterProfilePic,
      commentText: r.commentText,
      postThumbnailUrl: r.postThumbnailUrl || '',
      postCaption: r.postCaption || '',
      intent: mapIntentToReviewLabel(r.intent),
      confidence: r.confidence ?? 0,
      status: mapStatusToReviewStatus(r.status),
      rawStatus: r.status,
      classificationStatus: r.classificationStatus,
      classificationError: r.classificationError,
      suggestedDm: r.suggestedReply || '',
      publicReplyText: r.publicReplyText,
      dmReplyText: r.dmReplyText,
      dmSentAt: r.dmSentAt?.toISOString() ?? null,
      dmStatus: r.dmStatus,
      dmError: r.dmError,
      leadId: r.leadId,
      createdAt: (r.commentedAt || r.createdAt).toISOString(),
      needsReview: needsReviewQueue(r),
    }));

    return {
      comments,
      threshold: SOCIAL_COMMENT_LOW_CONFIDENCE,
    };
  });

  fastify.post('/comments/:id/classify', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

    try {
      const result = await classifySocialCommentById(workspaceId, id);
      if (result.classificationStatus === 'failed') {
        return reply.code(502).send({
          error: 'Classification failed',
          details: result.classificationError,
          ...result,
        });
      }
      return reply.send({
        success: true,
        ...result,
        intentLabel: mapIntentToReviewLabel(result.intent),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Classify failed';
      const code = /not found/i.test(message) ? 404 : 500;
      return reply.code(code).send({ error: message });
    }
  });

  fastify.post('/comments/:id/action', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as {
      action?: 'approve_dm' | 'approve_reply' | 'escalate' | 'ignore' | 'review';
      message?: string;
      instagramUserId?: string;
    };

    const row = await prisma.socialComment.findFirst({
      where: { id, workspaceId },
      include: { socialAccount: true },
    });
    if (!row) return reply.code(404).send({ error: 'Comment not found' });

    const action = body.action;
    if (!action) return reply.code(400).send({ error: 'Missing action' });

    let nextStatus = row.status;
    let replyId: string | null = null;
    let approveDmResult: Awaited<ReturnType<typeof executeApproveAndSendDm>> | null = null;

    try {
      if (action === 'ignore') {
        nextStatus = 'ignored';
      } else if (action === 'escalate') {
        nextStatus = 'escalated';
      } else if (action === 'approve_dm') {
        approveDmResult = await executeApproveAndSendDm({
          workspaceId,
          socialCommentId: row.id,
          instagramUserId: body.instagramUserId || row.socialAccount.instagramUserId,
          messageOverride: body.message,
        });
        nextStatus = approveDmResult.status;
        replyId = approveDmResult.publicReplyId;
      } else if (action === 'approve_reply' || action === 'review') {
        if (body.message?.trim()) {
          const res = await replyToListeningComment(
            workspaceId,
            row.commentId,
            body.message,
            body.instagramUserId || row.socialAccount.instagramUserId
          );
          replyId = res.id;
          nextStatus = 'replied';
          await prisma.socialComment.update({
            where: { id: row.id },
            data: {
              status: nextStatus,
              publicReplyText: body.message.trim(),
            },
          });
          return reply.send({
            success: true,
            id: row.id,
            status: nextStatus,
            reviewStatus: mapStatusToReviewStatus(nextStatus),
            replyId,
            publicReplyText: body.message.trim(),
          });
        } else {
          nextStatus = 'approved';
        }
      } else {
        return reply.code(400).send({ error: 'Unknown action' });
      }

      if (action !== 'approve_dm') {
        const updated = await prisma.socialComment.update({
          where: { id: row.id },
          data: { status: nextStatus },
        });
        return reply.send({
          success: true,
          id: updated.id,
          status: updated.status,
          reviewStatus: mapStatusToReviewStatus(updated.status),
          replyId,
        });
      }

      return reply.send({
        success: true,
        id: row.id,
        status: nextStatus,
        reviewStatus: mapStatusToReviewStatus(nextStatus),
        replyId,
        publicReplyText: approveDmResult?.publicReplyText,
        dmReplyText: approveDmResult?.dmReplyText,
        dmStatus: approveDmResult?.dmStatus,
        dmError: approveDmResult?.dmError,
        dmMessageId: approveDmResult?.dmMessageId,
        leadId: approveDmResult?.leadId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      return reply.code(502).send({ error: message });
    }
  });

  /** Retry Private Reply DM only (public reply already sent). */
  fastify.post('/comments/:id/retry-dm', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { instagramUserId?: string };

    try {
      const result = await retryPrivateReplyDm({
        workspaceId,
        socialCommentId: id,
        instagramUserId: body.instagramUserId,
      });
      if (result.dmStatus === 'failed') {
        return reply.code(502).send({
          error: 'DM failed — comment may be older than Meta’s private-reply window (~7 days)',
          details: result.dmError,
          ...result,
        });
      }
      return reply.send({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Retry DM failed';
      const code = /not found/i.test(message) ? 404 : 502;
      return reply.code(code).send({ error: message });
    }
  });
}
