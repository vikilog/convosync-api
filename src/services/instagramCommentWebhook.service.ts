import { getIo } from '../socket.js';
import { prisma } from '../index.js';
import { findOrCreateInstagramContact } from '../lib/instagramContact.js';
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
import {
  getPostCommentAutomationJourneyId,
  isPostAutomationEnabled,
} from './socialListeningPostSetting.service.js';
import { getInstagramJourneyContainer } from '../modules/instagram-journey/container.js';

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

async function ensureInstagramCommentContact(
  workspaceId: string,
  fromId: string | null | undefined,
  username: string | null | undefined
): Promise<string | null> {
  if (!fromId?.trim()) return null;
  const contact = await findOrCreateInstagramContact({
    db: prisma,
    workspaceId,
    scopedUserId: fromId.trim(),
    name: username?.trim()
      ? `@${username.replace(/^@/, '')}`
      : undefined,
  });
  return contact.id;
}

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

        try {
          // "Off (safe): every comment on this post stays in the review
          // queue" is the Social Listening agent panel's own promise to the
          // user — respect it here, or a post whose toggle was switched off
          // (or never configured) still gets auto-handled behind their back.
          const autoEnabled = await isPostAutomationEnabled(
            account.workspaceId,
            shaped.postId
          );
          const contactId = autoEnabled
            ? await ensureInstagramCommentContact(
                account.workspaceId,
                shaped.comment.fromId,
                shaped.comment.username
              )
            : null;
          if (contactId) {
            const postJourneyId = await getPostCommentAutomationJourneyId(
              account.workspaceId,
              shaped.postId
            );
            const trigger = getInstagramJourneyContainer(prisma).triggerService;
            if (postJourneyId) {
              await trigger.startPublishedJourney(
                account.workspaceId,
                postJourneyId,
                contactId,
                { restart: false }
              );
            } else {
              await trigger.handleCommentReceived({
                workspaceId: account.workspaceId,
                event: 'comment.received',
                contactId,
                text: shaped.comment.text || '',
                payload: {
                  postId: shaped.postId,
                  commentId: shaped.comment.id,
                  fromId: shaped.comment.fromId,
                },
              });
            }
          }
        } catch (igErr) {
          logCommentWebhook(
            'instagram journey comment trigger failed',
            igErr instanceof Error ? igErr.message : igErr
          );
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
