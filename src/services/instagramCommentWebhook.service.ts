import { getIo } from '../socket.js';
import { findInstagramAccountByEntryId } from './workspaceResolve.js';
import {
  triggerClassifyAfterUpsert,
  upsertListeningCommentsForPost,
} from './socialCommentSync.service.js';
import {
  isInstagramCommentWebhookField,
  shapeWebhookComment,
  type InstagramCommentWebhookValue,
} from './instagramCommentWebhook.shape.js';

export {
  isInstagramCommentWebhookField,
  shapeWebhookComment,
  type InstagramCommentWebhookValue,
} from './instagramCommentWebhook.shape.js';

function logCommentWebhook(label: string, payload: unknown) {
  console.log(
    `[Instagram Comment Webhook] ${label}`,
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  );
}

export type InstagramCommentWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{ field?: string; value?: InstagramCommentWebhookValue }>;
  }>;
};

export async function handleInstagramCommentWebhookBody(
  body: InstagramCommentWebhookBody
): Promise<number> {
  if (body.object !== 'page' && body.object !== 'instagram') return 0;

  let handled = 0;

  for (const entry of body.entry || []) {
    const entryId = entry.id;
    if (!entryId) continue;

    const changes = (entry.changes || []).filter((c) =>
      isInstagramCommentWebhookField(c.field)
    );
    if (changes.length === 0) continue;

    const account = await findInstagramAccountByEntryId(entryId);
    if (!account?.workspace) {
      logCommentWebhook('skip unregistered entry', { entryId });
      continue;
    }

    for (const change of changes) {
      const shaped = shapeWebhookComment(change.value || {});
      if (!shaped) {
        logCommentWebhook('skip unusable comment change', {
          entryId,
          field: change.field,
          value: change.value,
        });
        continue;
      }

      try {
        const { enriched, pendingClassifyIds } = await upsertListeningCommentsForPost({
          workspaceId: account.workspaceId,
          instagramUserId: account.instagramUserId,
          postId: shaped.postId,
          comments: [shaped.comment],
        });
        triggerClassifyAfterUpsert(account.workspaceId, pendingClassifyIds);

        const root = enriched[0];
        try {
          getIo().to(account.workspaceId).emit('social_comment', {
            postId: shaped.postId,
            commentId: shaped.comment.id,
            socialCommentId: root?.socialCommentId ?? null,
            username: shaped.comment.username,
            text: shaped.comment.text,
            field: change.field,
          });
        } catch {
          // socket may be down during boot — persist still succeeded
        }

        handled += 1;
        logCommentWebhook('upserted', {
          entryId,
          postId: shaped.postId,
          commentId: shaped.comment.id,
          pendingClassify: pendingClassifyIds.length,
        });
      } catch (err) {
        logCommentWebhook(
          'upsert failed',
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return handled;
}
