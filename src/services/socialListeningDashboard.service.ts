import { prisma } from '../index.js';
import { mapIntentToReviewLabel } from './socialCommentClassify.service.js';
import {
  countAutoDmsSentToday,
  getOrCreateSocialListeningSettings,
} from './socialListeningSettings.service.js';

export type DashboardRange = 'today' | '7d' | '30d' | 'all';

export function parseDashboardRange(raw: unknown): DashboardRange {
  const s = String(raw || '7d');
  if (s === 'today' || s === '7d' || s === '30d' || s === 'all') return s;
  return '7d';
}

/** Inclusive lower bound for commentedAt / createdAt filters (null = all time). */
export function rangeStart(range: DashboardRange, now = new Date()): Date | null {
  if (range === 'all') return null;
  const d = new Date(now);
  if (range === 'today') {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const days = range === '7d' ? 7 : 30;
  d.setTime(d.getTime() - days * 24 * 60 * 60 * 1000);
  return d;
}

function createdAtFilter(from: Date | null) {
  return from ? { createdAt: { gte: from } } : {};
}

export async function getDashboardStats(workspaceId: string, range: DashboardRange) {
  const from = rangeStart(range);
  const commentWhere = {
    workspaceId,
    ...(from
      ? {
          OR: [
            { commentedAt: { gte: from } },
            { commentedAt: null, createdAt: { gte: from } },
          ],
        }
      : {}),
  };

  const [totalComments, pendingReview, autoHandled, leadsCreated, settings, workspace] =
    await Promise.all([
      prisma.socialComment.count({ where: commentWhere }),
      prisma.socialComment.count({
        where: { workspaceId, status: 'new' },
      }),
      prisma.socialListeningActivity.count({
        where: {
          workspaceId,
          eventType: 'auto_dm',
          ...createdAtFilter(from),
        },
      }),
      prisma.lead.count({
        where: {
          workspaceId,
          source: 'instagram',
          ...createdAtFilter(from),
        },
      }),
      getOrCreateSocialListeningSettings(workspaceId),
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { timezone: true },
      }),
    ]);

  const tz = workspace?.timezone || 'Asia/Kolkata';
  const autoDmsSentToday = await countAutoDmsSentToday(workspaceId, tz);

  return {
    range,
    totalComments,
    pendingReview,
    autoHandled,
    leadsCreated,
    autoDmsSentToday,
    maxAutoDmsPerDay: settings.maxAutoDmsPerDay,
    autoResponseEnabled: settings.autoResponseEnabled,
  };
}

export async function getIntentBreakdown(workspaceId: string, range: DashboardRange) {
  const from = rangeStart(range);
  const groups = await prisma.socialComment.groupBy({
    by: ['intent'],
    where: {
      workspaceId,
      ...(from
        ? {
            OR: [
              { commentedAt: { gte: from } },
              { commentedAt: null, createdAt: { gte: from } },
            ],
          }
        : {}),
    },
    _count: { _all: true },
  });

  const intents = ['interested', 'question', 'complaint', 'spam', 'unclear'] as const;
  const byIntent: Record<string, number> = Object.fromEntries(intents.map((i) => [i, 0]));
  let unclassified = 0;
  for (const g of groups) {
    const key = g.intent || '';
    if (key in byIntent) byIntent[key] = g._count._all;
    else unclassified += g._count._all;
  }
  if (unclassified > 0) byIntent.unclear += unclassified;

  return {
    range,
    items: intents.map((intent) => ({
      intent,
      label: mapIntentToReviewLabel(intent),
      count: byIntent[intent] || 0,
    })),
  };
}

export async function getNeedsAttention(workspaceId: string, limit = 25) {
  const take = Math.min(Math.max(limit, 1), 50);

  // Align with Pending review: every status=new, plus failed DMs
  const [pending, failedDms] = await Promise.all([
    prisma.socialComment.findMany({
      where: { workspaceId, status: 'new' },
      orderBy: [{ commentedAt: 'asc' }, { createdAt: 'asc' }],
      take: 40,
    }),
    prisma.socialComment.findMany({
      where: { workspaceId, dmStatus: 'failed' },
      orderBy: [{ updatedAt: 'desc' }],
      take: 15,
    }),
  ]);

  type Item = {
    id: string;
    kind: 'complaint' | 'interested' | 'question' | 'pending' | 'failed_dm';
    priority: number;
    commentId: string;
    postId: string;
    username: string;
    commentText: string;
    postThumbnailUrl: string;
    postCaption: string;
    intent: ReturnType<typeof mapIntentToReviewLabel>;
    confidence: number;
    waitingSince: string;
    dmError: string | null;
    suggestedAction: 'approve_dm' | 'escalate' | 'retry_dm' | 'open_review';
  };

  const items: Item[] = [];
  const seen = new Set<string>();

  for (const r of pending) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);

    const intent = r.intent || '';
    let kind: Item['kind'] = 'pending';
    let priority = 3;
    let suggestedAction: Item['suggestedAction'] = 'open_review';

    if (intent === 'complaint') {
      kind = 'complaint';
      priority = 0;
      suggestedAction = 'escalate';
    } else if (intent === 'interested') {
      kind = 'interested';
      priority = 1;
      suggestedAction = 'approve_dm';
    } else if (intent === 'question') {
      kind = 'question';
      priority = 2;
      suggestedAction = 'open_review';
    }

    items.push({
      id: r.id,
      kind,
      priority,
      commentId: r.commentId,
      postId: r.postId,
      username: r.commenterUsername || 'instagram_user',
      commentText: r.commentText,
      postThumbnailUrl: r.postThumbnailUrl || '',
      postCaption: r.postCaption || '',
      intent: mapIntentToReviewLabel(r.intent),
      confidence: r.confidence ?? 0,
      waitingSince: (r.commentedAt || r.createdAt).toISOString(),
      dmError: null,
      suggestedAction,
    });
  }

  for (const r of failedDms) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    items.push({
      id: r.id,
      kind: 'failed_dm',
      priority: 4,
      commentId: r.commentId,
      postId: r.postId,
      username: r.commenterUsername || 'instagram_user',
      commentText: r.commentText,
      postThumbnailUrl: r.postThumbnailUrl || '',
      postCaption: r.postCaption || '',
      intent: mapIntentToReviewLabel(r.intent),
      confidence: r.confidence ?? 0,
      waitingSince: (r.dmSentAt || r.updatedAt || r.createdAt).toISOString(),
      dmError: r.dmError,
      suggestedAction: 'retry_dm',
    });
  }

  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime();
  });

  return { items: items.slice(0, take) };
}

export async function getTopPosts(workspaceId: string, range: DashboardRange, limit = 8) {
  const from = rangeStart(range);
  const take = Math.min(Math.max(limit, 1), 20);

  const groups = await prisma.socialComment.groupBy({
    by: ['postId'],
    where: {
      workspaceId,
      ...(from
        ? {
            OR: [
              { commentedAt: { gte: from } },
              { commentedAt: null, createdAt: { gte: from } },
            ],
          }
        : {}),
    },
    _count: { _all: true },
    orderBy: { _count: { postId: 'desc' } },
    take,
  });

  if (groups.length === 0) return { range, posts: [] };

  const postIds = groups.map((g) => g.postId);
  const samples = await prisma.socialComment.findMany({
    where: { workspaceId, postId: { in: postIds } },
    select: {
      postId: true,
      postThumbnailUrl: true,
      postCaption: true,
      leadId: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const meta = new Map<
    string,
    { thumbnail: string; caption: string; leadCount: number }
  >();
  for (const s of samples) {
    const cur = meta.get(s.postId) || { thumbnail: '', caption: '', leadCount: 0 };
    if (!cur.thumbnail && s.postThumbnailUrl) cur.thumbnail = s.postThumbnailUrl;
    if (!cur.caption && s.postCaption) cur.caption = s.postCaption;
    if (s.leadId) cur.leadCount += 1;
    meta.set(s.postId, cur);
  }

  // Lead counts more accurately via distinct leadId per post
  const leadRows = await prisma.socialComment.groupBy({
    by: ['postId'],
    where: {
      workspaceId,
      postId: { in: postIds },
      leadId: { not: null },
      ...(from
        ? {
            OR: [
              { commentedAt: { gte: from } },
              { commentedAt: null, createdAt: { gte: from } },
            ],
          }
        : {}),
    },
    _count: { _all: true },
  });
  const leadByPost = new Map(leadRows.map((r) => [r.postId, r._count._all]));

  return {
    range,
    posts: groups.map((g) => {
      const m = meta.get(g.postId);
      return {
        postId: g.postId,
        commentCount: g._count._all,
        leadCount: leadByPost.get(g.postId) || 0,
        postThumbnailUrl: m?.thumbnail || '',
        postCaption: m?.caption || '',
      };
    }),
  };
}
