import { prisma } from '../index.js';
import type { InstagramListeningComment } from './instagramListening.service.js';
import {
  enqueueClassifyPendingComments,
  mapIntentToReviewLabel,
  mapStatusToReviewStatus,
} from './socialCommentClassify.service.js';

export type EnrichedListeningComment = Omit<InstagramListeningComment, 'replies'> & {
  socialCommentId: string | null;
  intent: string | null;
  intentLabel: 'Interested' | 'Question' | 'Complaint' | 'Spam' | 'Neutral' | null;
  confidence: number | null;
  classificationStatus: 'pending' | 'classified' | 'failed' | null;
  classificationError: string | null;
  reviewStatus: 'pending' | 'approved' | 'ignored' | null;
  suggestedReply: string | null;
  status: string | null;
  publicReplyText: string | null;
  dmReplyText: string | null;
  dmSentAt: string | null;
  dmStatus: string | null;
  dmError: string | null;
  leadId: string | null;
  replies: EnrichedListeningComment[];
};

function flattenComments(
  comments: InstagramListeningComment[],
  parentId: string | null = null
): Array<InstagramListeningComment & { parentCommentId: string | null }> {
  const out: Array<InstagramListeningComment & { parentCommentId: string | null }> = [];
  for (const c of comments) {
    out.push({
      ...c,
      parentCommentId: parentId ?? c.parentCommentId ?? null,
    });
    if (c.replies?.length) {
      out.push(...flattenComments(c.replies, c.id));
    }
  }
  return out;
}

export async function upsertListeningCommentsForPost(input: {
  workspaceId: string;
  instagramUserId?: string | null;
  postId: string;
  comments: InstagramListeningComment[];
  postCaption?: string | null;
  postThumbnailUrl?: string | null;
}): Promise<{
  enriched: EnrichedListeningComment[];
  pendingClassifyIds: string[];
}> {
  const account = input.instagramUserId
    ? await prisma.instagramAccount.findFirst({
        where: { workspaceId: input.workspaceId, instagramUserId: input.instagramUserId },
      })
    : await prisma.instagramAccount.findFirst({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: 'desc' },
      });

  if (!account) {
    return {
      enriched: input.comments.map((c) => enrichTree(c, new Map())),
      pendingClassifyIds: [],
    };
  }

  const flat = flattenComments(input.comments);
  const pendingClassifyIds: string[] = [];

  for (const c of flat) {
    const existing = await prisma.socialComment.findUnique({
      where: {
        workspaceId_commentId: {
          workspaceId: input.workspaceId,
          commentId: c.id,
        },
      },
    });

    const isOwnComment =
      Boolean(c.fromId && c.fromId === account.instagramUserId) ||
      Boolean(
        c.username &&
          account.username &&
          c.username.toLowerCase() === account.username.toLowerCase()
      );

    const row = await prisma.socialComment.upsert({
      where: {
        workspaceId_commentId: {
          workspaceId: input.workspaceId,
          commentId: c.id,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        socialAccountId: account.id,
        postId: input.postId,
        commentId: c.id,
        parentCommentId: c.parentCommentId,
        commenterUsername: c.username,
        commenterId: c.fromId,
        commenterProfilePic: null,
        commentText: c.text || '',
        classificationStatus: isOwnComment ? 'classified' : 'pending',
        // ponytail: page's own replies must not clog the review queue
        status: isOwnComment ? 'ignored' : 'new',
        intent: isOwnComment ? 'unclear' : null,
        confidence: isOwnComment ? 1 : null,
        postCaption: input.postCaption ?? null,
        postThumbnailUrl: input.postThumbnailUrl ?? null,
        commentedAt: c.timestamp ? new Date(c.timestamp) : null,
      },
      update: {
        commentText: c.text || '',
        commenterUsername: c.username,
        commenterId: c.fromId,
        parentCommentId: c.parentCommentId,
        postCaption: input.postCaption ?? undefined,
        postThumbnailUrl: input.postThumbnailUrl ?? undefined,
        commentedAt: c.timestamp ? new Date(c.timestamp) : undefined,
        ...(isOwnComment && (!existing || existing.status === 'new')
          ? { status: 'ignored', classificationStatus: 'classified' }
          : {}),
      },
    });

    if (isOwnComment) continue;

    const needsClassify =
      !existing ||
      existing.classificationStatus === 'pending' ||
      existing.classificationStatus === 'failed' ||
      existing.commentText !== (c.text || '');

    if (needsClassify && row.commentText.trim()) {
      if (existing && existing.commentText !== (c.text || '')) {
        await prisma.socialComment.update({
          where: { id: row.id },
          data: {
            classificationStatus: 'pending',
            classificationError: null,
            intent: null,
            confidence: null,
          },
        });
      }
      pendingClassifyIds.push(row.id);
    }
  }

  const dbRows = await prisma.socialComment.findMany({
    where: {
      workspaceId: input.workspaceId,
      postId: input.postId,
      commentId: { in: flat.map((c) => c.id) },
    },
  });
  const byCommentId = new Map(dbRows.map((r) => [r.commentId, r]));

  const enriched = await applyLeadIdsFromCommenters(
    input.workspaceId,
    input.comments.map((c) => enrichTree(c, byCommentId))
  );

  return {
    enriched,
    pendingClassifyIds,
  };
}

/** Fill leadId from any workspace Lead / sibling comment for the same IG handle. */
async function applyLeadIdsFromCommenters(
  workspaceId: string,
  comments: EnrichedListeningComment[]
): Promise<EnrichedListeningComment[]> {
  const names = new Set<string>();
  const collect = (list: EnrichedListeningComment[]) => {
    for (const c of list) {
      if (c.username?.trim()) names.add(c.username.trim());
      if (c.replies?.length) collect(c.replies);
    }
  };
  collect(comments);
  if (names.size === 0) return comments;

  const nameList = [...names];
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId,
      OR: nameList.map((u) => ({
        originUsername: { equals: u, mode: 'insensitive' as const },
      })),
    },
    select: { id: true, originUsername: true },
    orderBy: { createdAt: 'desc' },
  });

  const leadByUser = new Map<string, string>();
  for (const lead of leads) {
    if (!lead.originUsername) continue;
    const key = lead.originUsername.toLowerCase();
    if (!leadByUser.has(key)) leadByUser.set(key, lead.id);
  }

  // Sibling comments on any post that already have leadId
  const siblings = await prisma.socialComment.findMany({
    where: {
      workspaceId,
      leadId: { not: null },
      OR: nameList.map((u) => ({
        commenterUsername: { equals: u, mode: 'insensitive' as const },
      })),
    },
    select: { commenterUsername: true, leadId: true },
  });
  for (const s of siblings) {
    if (!s.commenterUsername || !s.leadId) continue;
    const key = s.commenterUsername.toLowerCase();
    if (!leadByUser.has(key)) leadByUser.set(key, s.leadId);
  }

  const apply = (c: EnrichedListeningComment): EnrichedListeningComment => {
    const fromUser =
      !c.leadId && c.username
        ? leadByUser.get(c.username.trim().toLowerCase()) ?? null
        : null;
    return {
      ...c,
      leadId: c.leadId || fromUser,
      replies: (c.replies || []).map(apply),
    };
  };
  return comments.map(apply);
}

function enrichTree(
  comment: InstagramListeningComment,
  byCommentId: Map<
    string,
    {
      id: string;
      intent: string | null;
      confidence: number | null;
      classificationStatus: string;
      classificationError: string | null;
      status: string;
      suggestedReply: string | null;
      publicReplyText: string | null;
      dmReplyText: string | null;
      dmSentAt: Date | null;
      dmStatus: string;
      dmError: string | null;
      leadId: string | null;
    }
  >
): EnrichedListeningComment {
  const row = byCommentId.get(comment.id);
  return {
    ...comment,
    socialCommentId: row?.id ?? null,
    intent: row?.intent ?? null,
    intentLabel: row?.intent ? mapIntentToReviewLabel(row.intent) : null,
    confidence: row?.confidence ?? null,
    classificationStatus: (row?.classificationStatus as EnrichedListeningComment['classificationStatus']) ?? null,
    classificationError: row?.classificationError ?? null,
    reviewStatus: row ? mapStatusToReviewStatus(row.status) : null,
    suggestedReply: row?.suggestedReply ?? null,
    status: row?.status ?? null,
    publicReplyText: row?.publicReplyText ?? null,
    dmReplyText: row?.dmReplyText ?? null,
    dmSentAt: row?.dmSentAt ? row.dmSentAt.toISOString() : null,
    dmStatus: row?.dmStatus ?? null,
    dmError: row?.dmError ?? null,
    leadId: row?.leadId ?? null,
    replies: (comment.replies || []).map((r) => enrichTree(r, byCommentId)),
  };
}

export function triggerClassifyAfterUpsert(
  workspaceId: string,
  pendingClassifyIds: string[]
): void {
  if (pendingClassifyIds.length === 0) return;
  enqueueClassifyPendingComments(workspaceId, pendingClassifyIds);
}
