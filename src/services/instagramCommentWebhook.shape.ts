import type { InstagramListeningComment } from './instagramListening.service.js';

/** Meta `comments` / `live_comments` change value (field names vary slightly by API version). */
export type InstagramCommentWebhookValue = {
  id?: string;
  comment_id?: string;
  parent_id?: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string; media_product_type?: string };
  verb?: string;
};

/** Meta Page `feed` change value for a comment item (feed also carries post/photo/share/reaction/status/video events). */
export type FacebookFeedWebhookValue = {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  message?: string;
  sender_id?: string;
  sender_name?: string;
  created_time?: number | string;
};

export function isInstagramCommentWebhookField(field: string | undefined): boolean {
  return field === 'comments' || field === 'live_comments' || field === 'feed';
}

export function isFacebookFeedCommentValue(value: FacebookFeedWebhookValue): boolean {
  return value.item === 'comment' && (value.verb || 'add').toLowerCase() === 'add';
}

/** Shape one Meta comment change into our listening comment row. */
export function shapeWebhookComment(
  value: InstagramCommentWebhookValue
): { postId: string; comment: InstagramListeningComment } | null {
  const commentId = (value.comment_id || value.id || '').trim();
  const postId = (value.media?.id || '').trim();
  if (!commentId || !postId) return null;

  const verb = (value.verb || 'add').toLowerCase();
  if (verb === 'remove' || verb === 'hide') return null;

  return {
    postId,
    comment: {
      id: commentId,
      text: value.text ?? '',
      username: value.from?.username ?? null,
      timestamp: new Date().toISOString(),
      likeCount: null,
      fromId: value.from?.id ?? null,
      parentCommentId: value.parent_id?.trim() || null,
      replies: [],
    },
  };
}

/** Shape one Facebook Page `feed` comment change into our listening comment row. */
export function shapeFacebookFeedComment(
  value: FacebookFeedWebhookValue
): { postId: string; comment: InstagramListeningComment } | null {
  if (!isFacebookFeedCommentValue(value)) return null;

  const commentId = (value.comment_id || '').trim();
  const postId = (value.post_id || '').trim();
  if (!commentId || !postId) return null;

  const parentId = (value.parent_id || '').trim();
  const parentCommentId = parentId && parentId !== postId ? parentId : null;

  const createdTime =
    typeof value.created_time === 'number'
      ? new Date(value.created_time * 1000).toISOString()
      : typeof value.created_time === 'string' && value.created_time
        ? new Date(Number(value.created_time) * 1000).toISOString()
        : new Date().toISOString();

  return {
    postId,
    comment: {
      id: commentId,
      text: value.message ?? '',
      username: value.sender_name ?? null,
      timestamp: createdTime,
      likeCount: null,
      fromId: value.sender_id ?? null,
      parentCommentId,
      replies: [],
    },
  };
}
