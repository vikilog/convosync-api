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

export function isInstagramCommentWebhookField(field: string | undefined): boolean {
  return field === 'comments' || field === 'live_comments';
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
