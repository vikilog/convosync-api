import axios from 'axios';
import { prisma } from '../index.js';
import { decryptSecret } from '../lib/field-encryption.js';
import { getWorkspaceInstagramCredentials } from './instagramCredentials.js';

const GRAPH = 'https://graph.facebook.com/v25.0';

const PROFILE_FIELDS =
  'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url';

const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{id,media_type,media_url,thumbnail_url}';

export type InstagramListeningProfile = {
  instagramUserId: string;
  pageId: string;
  pageName: string | null;
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  followersCount: number | null;
  followsCount: number | null;
  mediaCount: number | null;
  profilePictureUrl: string | null;
};

export type InstagramListeningMediaItem = {
  id: string;
  caption: string | null;
  mediaType: string;
  mediaProductType: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  likeCount: number | null;
  commentsCount: number | null;
  isReel: boolean;
};

export type InstagramListeningMediaPage = {
  items: InstagramListeningMediaItem[];
  nextCursor: string | null;
};

type GraphProfile = {
  id?: string;
  username?: string;
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
};

type GraphMediaNode = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
};

function graphErrorMessage(err: unknown): string {
  const ax = err as {
    response?: { data?: { error?: { message?: string } } };
    message?: string;
  };
  return ax.response?.data?.error?.message || ax.message || 'Instagram Graph request failed';
}

async function resolveListeningCredentials(
  workspaceId: string,
  instagramUserId?: string | null
): Promise<{
  pageId: string;
  pageAccessToken: string;
  instagramUserId: string;
  pageName: string | null;
  username: string | null;
  displayName: string | null;
  profilePicture: string | null;
}> {
  if (instagramUserId) {
    const account = await prisma.instagramAccount.findFirst({
      where: { workspaceId, instagramUserId },
    });
    const pageAccessToken = decryptSecret(account?.pageAccessToken);
    if (!account || !pageAccessToken) {
      throw new Error('Instagram not connected');
    }
    return {
      pageId: account.pageId,
      pageAccessToken,
      instagramUserId: account.instagramUserId,
      pageName: account.pageName,
      username: account.username,
      displayName: account.displayName,
      profilePicture: account.profilePicture,
    };
  }

  try {
    const creds = await getWorkspaceInstagramCredentials(workspaceId);
    const account = await prisma.instagramAccount.findFirst({
      where: { workspaceId, instagramUserId: creds.instagramUserId },
      select: { pageName: true, profilePicture: true, displayName: true, username: true },
    });

    return {
      pageId: creds.pageId,
      pageAccessToken: creds.pageAccessToken,
      instagramUserId: creds.instagramUserId,
      pageName: account?.pageName ?? null,
      username: account?.username ?? creds.username ?? null,
      displayName: account?.displayName ?? creds.displayName ?? null,
      profilePicture: account?.profilePicture ?? null,
    };
  } catch {
    throw new Error('Instagram not connected');
  }
}

export function shapeListeningMediaItem(node: GraphMediaNode): InstagramListeningMediaItem {
  const mediaProductType = node.media_product_type ?? null;
  const mediaType = node.media_type || 'IMAGE';
  return {
    id: node.id,
    caption: node.caption ?? null,
    mediaType,
    mediaProductType,
    mediaUrl: node.media_url ?? null,
    thumbnailUrl: node.thumbnail_url ?? node.media_url ?? null,
    permalink: node.permalink ?? null,
    timestamp: node.timestamp ?? null,
    likeCount: typeof node.like_count === 'number' ? node.like_count : null,
    commentsCount: typeof node.comments_count === 'number' ? node.comments_count : null,
    isReel: mediaProductType === 'REELS' || mediaType === 'REELS',
  };
}

export async function getListeningProfile(
  workspaceId: string,
  instagramUserId?: string | null
): Promise<InstagramListeningProfile> {
  const creds = await resolveListeningCredentials(workspaceId, instagramUserId);

  let graph: GraphProfile = {};
  try {
    const res = await axios.get<GraphProfile>(`${GRAPH}/${creds.instagramUserId}`, {
      params: {
        fields: PROFILE_FIELDS,
        access_token: creds.pageAccessToken,
      },
    });
    graph = res.data ?? {};
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }

  return {
    instagramUserId: graph.id || creds.instagramUserId,
    pageId: creds.pageId,
    pageName: creds.pageName,
    username: graph.username ?? creds.username,
    name: graph.name ?? creds.displayName,
    biography: graph.biography ?? null,
    website: graph.website ?? null,
    followersCount: typeof graph.followers_count === 'number' ? graph.followers_count : null,
    followsCount: typeof graph.follows_count === 'number' ? graph.follows_count : null,
    mediaCount: typeof graph.media_count === 'number' ? graph.media_count : null,
    profilePictureUrl: graph.profile_picture_url ?? creds.profilePicture,
  };
}

export async function listListeningMedia(
  workspaceId: string,
  opts: { after?: string | null; limit?: number; instagramUserId?: string | null } = {}
): Promise<InstagramListeningMediaPage> {
  const creds = await resolveListeningCredentials(workspaceId, opts.instagramUserId);
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 50);

  try {
    const res = await axios.get<{
      data?: GraphMediaNode[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${GRAPH}/${creds.instagramUserId}/media`, {
      params: {
        fields: MEDIA_FIELDS,
        access_token: creds.pageAccessToken,
        limit,
        ...(opts.after ? { after: opts.after } : {}),
      },
    });

    const items = (res.data.data ?? []).map(shapeListeningMediaItem);
    const nextCursor = res.data.paging?.cursors?.after && res.data.paging?.next
      ? res.data.paging.cursors.after
      : null;

    return { items, nextCursor };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

const COMMENT_FIELDS =
  'id,text,username,timestamp,like_count,from,replies{id,text,username,timestamp,like_count,from}';

export type InstagramListeningComment = {
  id: string;
  text: string;
  username: string | null;
  timestamp: string | null;
  likeCount: number | null;
  fromId: string | null;
  /** Set for webhook reply events (flat, not nested under parent). */
  parentCommentId?: string | null;
  replies: InstagramListeningComment[];
};

type GraphCommentNode = {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  from?: { id?: string; username?: string };
  replies?: { data?: GraphCommentNode[] };
};

export function shapeListeningComment(node: GraphCommentNode): InstagramListeningComment {
  const nested = (node.replies?.data ?? []).map(shapeListeningComment);
  return {
    id: node.id,
    text: node.text ?? '',
    username: node.username ?? node.from?.username ?? null,
    timestamp: node.timestamp ?? null,
    likeCount: typeof node.like_count === 'number' ? node.like_count : null,
    fromId: node.from?.id ?? null,
    replies: nested,
  };
}

/** Drop the connected page's own comments/replies — those are our public replies, not inbound. */
export function filterOutOwnListeningComments(
  comments: InstagramListeningComment[],
  own: { instagramUserId?: string | null; username?: string | null }
): InstagramListeningComment[] {
  const ownId = own.instagramUserId || null;
  const ownUser = own.username?.trim().toLowerCase() || null;

  const isOwn = (c: InstagramListeningComment) => {
    if (ownId && c.fromId && c.fromId === ownId) return true;
    if (ownUser && c.username && c.username.trim().toLowerCase() === ownUser) return true;
    return false;
  };

  return comments
    .filter((c) => !isOwn(c))
    .map((c) => ({
      ...c,
      replies: filterOutOwnListeningComments(c.replies, own),
    }));
}

export async function getListeningMediaDetail(
  workspaceId: string,
  mediaId: string,
  instagramUserId?: string | null
): Promise<InstagramListeningMediaItem> {
  const creds = await resolveListeningCredentials(workspaceId, instagramUserId);
  try {
    const res = await axios.get<GraphMediaNode>(`${GRAPH}/${mediaId}`, {
      params: {
        fields: MEDIA_FIELDS,
        access_token: creds.pageAccessToken,
      },
    });
    return shapeListeningMediaItem(res.data);
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

export async function listListeningComments(
  workspaceId: string,
  mediaId: string,
  opts: { after?: string | null; limit?: number; instagramUserId?: string | null } = {}
): Promise<{ comments: InstagramListeningComment[]; nextCursor: string | null }> {
  const creds = await resolveListeningCredentials(workspaceId, opts.instagramUserId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

  try {
    const res = await axios.get<{
      data?: GraphCommentNode[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${GRAPH}/${mediaId}/comments`, {
      params: {
        fields: COMMENT_FIELDS,
        access_token: creds.pageAccessToken,
        limit,
        ...(opts.after ? { after: opts.after } : {}),
      },
    });

    const comments = filterOutOwnListeningComments(
      (res.data.data ?? []).map(shapeListeningComment),
      {
        instagramUserId: creds.instagramUserId,
        username: creds.username,
      }
    );
    const nextCursor =
      res.data.paging?.cursors?.after && res.data.paging?.next
        ? res.data.paging.cursors.after
        : null;

    return { comments, nextCursor };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

export async function replyToListeningComment(
  workspaceId: string,
  commentId: string,
  message: string,
  instagramUserId?: string | null
): Promise<{ id: string }> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('Reply message is required');

  const creds = await resolveListeningCredentials(workspaceId, instagramUserId);

  try {
    // Instagram Graph: POST /{ig-comment-id}/replies
    const res = await axios.post<{ id?: string }>(
      `${GRAPH}/${commentId}/replies`,
      null,
      {
        params: {
          message: trimmed,
          access_token: creds.pageAccessToken,
        },
      }
    );
    if (!res.data?.id) throw new Error('Reply failed — no comment id returned');
    return { id: res.data.id };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

/**
 * Meta Private Reply — DM to commenter within ~7 days of the comment.
 * POST /{page-id}/messages with recipient.comment_id
 * @see https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies
 */
export async function sendPrivateReplyToComment(
  workspaceId: string,
  commentId: string,
  message: string,
  instagramUserId?: string | null
): Promise<{ messageId: string; recipientId?: string }> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('DM message is required');

  const creds = await resolveListeningCredentials(workspaceId, instagramUserId);

  try {
    const res = await axios.post<{ message_id?: string; recipient_id?: string }>(
      `${GRAPH}/${creds.pageId}/messages`,
      {
        recipient: { comment_id: commentId },
        message: { text: trimmed },
      },
      {
        params: { access_token: creds.pageAccessToken },
        headers: { 'Content-Type': 'application/json' },
      }
    );

    console.info('[instagram.private_reply] ok', {
      pageId: creds.pageId,
      commentId,
      messageId: res.data?.message_id,
      recipientId: res.data?.recipient_id,
    });

    if (!res.data?.message_id) {
      throw new Error('Private reply failed — no message_id returned');
    }
    return {
      messageId: res.data.message_id,
      recipientId: res.data.recipient_id,
    };
  } catch (err) {
    console.warn('[instagram.private_reply] failed', {
      pageId: creds.pageId,
      commentId,
      error: graphErrorMessage(err),
    });
    throw new Error(graphErrorMessage(err));
  }
}
