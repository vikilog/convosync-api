import { getIo } from '../socket.js';
import { prisma } from '../index.js';
import { findOrCreateInstagramContact } from '../lib/instagramContact.js';
import { findOrCreateMessengerContact } from '../lib/messengerContact.js';
import { findInstagramAccountByEntryId, findWorkspaceByFbPageId } from './workspaceResolve.js';
import {
  triggerClassifyAfterUpsert,
  upsertListeningCommentsForPost,
  type SocialListeningPlatform,
} from './socialCommentSync.service.js';
import {
  isInstagramCommentWebhookField,
  shapeWebhookComment,
  shapeFacebookFeedComment,
  type InstagramCommentWebhookValue,
  type FacebookFeedWebhookValue,
} from './instagramCommentWebhook.shape.js';
import {
  getPostCommentAutomationJourneyId,
  isPostAutomationEnabled,
} from './socialListeningPostSetting.service.js';
import { getInstagramJourneyContainer } from '../modules/instagram-journey/container.js';
import type { InstagramListeningComment } from './instagramListening.service.js';

export {
  isInstagramCommentWebhookField,
  shapeWebhookComment,
  shapeFacebookFeedComment,
  type InstagramCommentWebhookValue,
  type FacebookFeedWebhookValue,
} from './instagramCommentWebhook.shape.js';

function logCommentWebhook(label: string, payload: unknown) {
  console.log(
    `[Social Comment Webhook] ${label}`,
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  );
}

export type InstagramCommentWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{
      field?: string;
      value?: InstagramCommentWebhookValue & FacebookFeedWebhookValue;
    }>;
  }>;
};

/** Resolve/create the Contact for a commenter, branching by platform (IG scoped-id vs FB PSID). */
async function ensureSocialCommentContact(
  workspaceId: string,
  platform: SocialListeningPlatform,
  fromId: string | null | undefined,
  username: string | null | undefined
): Promise<string | null> {
  if (!fromId?.trim()) return null;
  const id = fromId.trim();

  if (platform === 'facebook') {
    const contact = await findOrCreateMessengerContact({
      db: prisma,
      workspaceId,
      psid: id,
      name: username?.trim() ? username.trim() : `Facebook ${id.slice(-6)}`,
    });
    return contact.id;
  }

  const contact = await findOrCreateInstagramContact({
    db: prisma,
    workspaceId,
    scopedUserId: id,
    name: username?.trim() ? `@${username.replace(/^@/, '')}` : undefined,
  });
  return contact.id;
}

/** Shared ingestion for one shaped comment: persist, classify, emit, and (Instagram-only) trigger journeys. */
async function processShapedComment(input: {
  workspaceId: string;
  platform: SocialListeningPlatform;
  instagramUserId?: string | null;
  entryId: string;
  field?: string;
  shaped: { postId: string; comment: InstagramListeningComment };
}): Promise<boolean> {
  const { workspaceId, platform, shaped, entryId, field } = input;

  try {
    const { enriched, pendingClassifyIds } = await upsertListeningCommentsForPost({
      workspaceId,
      platform,
      instagramUserId: input.instagramUserId,
      postId: shaped.postId,
      comments: [shaped.comment],
    });
    triggerClassifyAfterUpsert(workspaceId, pendingClassifyIds);

    const root = enriched[0];
    try {
      getIo().to(workspaceId).emit('social_comment', {
        platform,
        postId: shaped.postId,
        commentId: shaped.comment.id,
        socialCommentId: root?.socialCommentId ?? null,
        username: shaped.comment.username,
        text: shaped.comment.text,
        field,
      });
    } catch {
      // socket may be down during boot — persist still succeeded
    }

    if (platform === 'instagram') {
      try {
        // "Off (safe): every comment on this post stays in the review
        // queue" is the Social Listening agent panel's own promise to the
        // user — respect it here, or a post whose toggle was switched off
        // (or never configured) still gets auto-handled behind their back.
        const autoEnabled = await isPostAutomationEnabled(workspaceId, shaped.postId);
        const contactId = autoEnabled
          ? await ensureSocialCommentContact(
              workspaceId,
              platform,
              shaped.comment.fromId,
              shaped.comment.username
            )
          : null;
        if (contactId) {
          const postJourneyId = await getPostCommentAutomationJourneyId(
            workspaceId,
            shaped.postId
          );
          const trigger = getInstagramJourneyContainer(prisma).triggerService;
          if (postJourneyId) {
            await trigger.startPublishedJourney(workspaceId, postJourneyId, contactId, {
              restart: false,
            });
          } else {
            await trigger.handleCommentReceived({
              workspaceId,
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
    }

    logCommentWebhook('upserted', {
      entryId,
      platform,
      postId: shaped.postId,
      commentId: shaped.comment.id,
      pendingClassify: pendingClassifyIds.length,
    });
    return true;
  } catch (err) {
    logCommentWebhook('upsert failed', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function handleSocialCommentWebhookBody(
  body: InstagramCommentWebhookBody
): Promise<number> {
  if (body.object !== 'page' && body.object !== 'instagram') return 0;

  let handled = 0;

  for (const entry of body.entry || []) {
    const entryId = entry.id;
    if (!entryId) continue;

    const changes = (entry.changes || []).filter((c) => isInstagramCommentWebhookField(c.field));
    if (changes.length === 0) continue;

    // Both may resolve for the same underlying Page id (an IG business
    // account is linked to a Facebook Page) — branch per-change by field.
    const [instagramAccount, fbWorkspace] = await Promise.all([
      findInstagramAccountByEntryId(entryId),
      findWorkspaceByFbPageId(entryId),
    ]);

    for (const change of changes) {
      if (change.field === 'feed') {
        if (!fbWorkspace) {
          logCommentWebhook('skip unregistered facebook page entry', { entryId });
          continue;
        }
        const shaped = shapeFacebookFeedComment(change.value || {});
        if (!shaped) continue;

        const ok = await processShapedComment({
          workspaceId: fbWorkspace.id,
          platform: 'facebook',
          entryId,
          field: change.field,
          shaped,
        });
        if (ok) handled += 1;
        continue;
      }

      if (!instagramAccount?.workspace) {
        logCommentWebhook('skip unregistered entry', { entryId });
        continue;
      }
      const shaped = shapeWebhookComment(change.value || {});
      if (!shaped) {
        logCommentWebhook('skip unusable comment change', {
          entryId,
          field: change.field,
          value: change.value,
        });
        continue;
      }

      const ok = await processShapedComment({
        workspaceId: instagramAccount.workspaceId,
        platform: 'instagram',
        instagramUserId: instagramAccount.instagramUserId,
        entryId,
        field: change.field,
        shaped,
      });
      if (ok) handled += 1;
    }
  }

  return handled;
}
