import { prisma } from '../index.js';
import { AiProviderConfigService } from '../modules/ai-agent/services/ai-provider-config.service.js';
import { LlmClient } from '../modules/ai-agent/services/llm-client.service.js';
import {
  replyToListeningComment,
  sendPrivateReplyToComment,
} from './instagramListening.service.js';
import {
  replyToFacebookComment,
  sendFacebookPrivateReply,
} from './facebookListening.service.js';
import type { SocialListeningPlatform } from './socialCommentSync.service.js';
import { createLeadFromSocialComment } from './lead.service.js';
import {
  shouldCreateLeadForIntent,
  startOfDayInTz,
  type ReplyTone,
} from './socialListeningSettings.service.js';
import {
  getEffectivePostSettings,
} from './socialListeningPostSetting.service.js';
import { logSocialListeningActivity } from './socialListeningActivity.service.js';
import { mapIntentToReviewLabel } from './socialCommentClassify.service.js';

/** Post the public comment reply on the correct platform's Graph API. */
async function postPublicReply(
  workspaceId: string,
  platform: SocialListeningPlatform,
  commentId: string,
  text: string,
  igUserId?: string | null
): Promise<{ id: string }> {
  return platform === 'facebook'
    ? replyToFacebookComment(workspaceId, commentId, text)
    : replyToListeningComment(workspaceId, commentId, text, igUserId);
}

/** Send the private-reply DM on the correct platform's Graph API. */
async function sendPrivateReply(
  workspaceId: string,
  platform: SocialListeningPlatform,
  commentId: string,
  text: string,
  igUserId?: string | null
): Promise<{ messageId: string; recipientId?: string }> {
  return platform === 'facebook'
    ? sendFacebookPrivateReply(workspaceId, commentId, text)
    : sendPrivateReplyToComment(workspaceId, commentId, text, igUserId);
}

function toneInstruction(tone: ReplyTone): string {
  switch (tone) {
    case 'professional':
      return 'Tone: professional, clear, concise. Avoid slang and excessive enthusiasm.';
    case 'playful':
      return 'Tone: playful and warm, light humor OK, still brand-safe.';
    default:
      return 'Tone: friendly and approachable.';
  }
}

export type ApproveDmTexts = {
  publicReply: string;
  dmReply: string;
};

export async function generateApproveDmTexts(input: {
  workspaceId: string;
  commentText: string;
  postCaption?: string | null;
  username?: string | null;
  suggestedReply?: string | null;
  publicReplyTone?: ReplyTone;
  skillInstructions?: string | null;
  fallbackMessage?: string | null;
}): Promise<ApproveDmTexts> {
  const tone = input.publicReplyTone || 'friendly';
  const skillBlock = input.skillInstructions?.trim()
    ? `\nAgent skill context (follow when writing the DM):\n${input.skillInstructions.trim().slice(0, 1500)}`
    : '';

  const systemPrompt = `You help a brand respond to a social media post comment (Instagram or Facebook Page).

Generate TWO texts in one JSON object:
1. publicReply — short public comment reply (max 20 words). Acknowledgment only.
   Do NOT include pricing, phone numbers, emails, links, or hard sales pitches.
   Vary wording based on the comment; point naturally toward DMs without sounding robotic.
2. dmReply — fuller private DM (2–5 short sentences). Conversational, helpful, brand-safe.
   Answer or engage with what they said; invite a next step. No hashtag spam.

${toneInstruction(tone)}${skillBlock}

Respond with ONLY JSON:
{"publicReply":"...","dmReply":"..."}`;

  const fallback = (): ApproveDmTexts => {
    const name = input.username ? `@${input.username}` : 'there';
    const fb = input.fallbackMessage?.trim();
    if (fb) {
      return {
        publicReply: `Thanks ${name} — just sent you a DM!`,
        dmReply: fb.slice(0, 900),
      };
    }
    return {
      publicReply: `Thanks ${name} — just sent you a DM!`,
      dmReply:
        input.suggestedReply?.trim() ||
        `Hey${input.username ? ` @${input.username}` : ''}! Thanks for your comment — happy to help. What are you most interested in?`,
    };
  };

  try {
    const providerConfig = new AiProviderConfigService(prisma);
    const resolved = await providerConfig.resolveForWorkspace(input.workspaceId);
    const llm = new LlmClient(resolved);

    const userBlock = [
      input.username ? `Commenter: @${input.username}` : null,
      input.postCaption ? `Post caption: ${input.postCaption.slice(0, 400)}` : null,
      `Comment: ${input.commentText.slice(0, 800)}`,
      input.suggestedReply
        ? `Earlier draft hint (optional): ${input.suggestedReply.slice(0, 300)}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await llm.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userBlock },
      ],
      { maxTokens: 280, temperature: 0.4, jsonMode: true, workspaceId: input.workspaceId }
    );

    const parsed = JSON.parse(result.content) as {
      publicReply?: string;
      dmReply?: string;
    };
    const publicReply = (parsed.publicReply || '').trim().slice(0, 220);
    const dmReply = (parsed.dmReply || '').trim().slice(0, 900);
    if (!publicReply || !dmReply) throw new Error('empty');
    return { publicReply, dmReply };
  } catch {
    return fallback();
  }
}

export type ApproveDmResult = {
  status: string;
  publicReplyId: string | null;
  publicReplyText: string;
  dmReplyText: string;
  dmStatus: 'sent' | 'failed' | 'skipped';
  dmError: string | null;
  dmMessageId: string | null;
  leadId: string | null;
};

/**
 * Approve & Send DM flow:
 * 1) AI dual text (tone + optional skill from settings)
 * 2) public comment reply
 * 3) private reply DM (isolated failure)
 * 4) audit fields + lead creation per leadCreationRule
 */
/** Release a reserved maxAutoDmsPerDay slot when the attempt didn't end in an actual send. */
async function releaseAutoDmReservation(
  workspaceId: string,
  postId: string,
  since: Date
): Promise<void> {
  await prisma
    .$executeRaw`
      UPDATE "SocialListeningPostSetting"
      SET "autoDmsCounterCount" = GREATEST("autoDmsCounterCount" - 1, 0)
      WHERE "workspaceId" = ${workspaceId} AND "postId" = ${postId}
        AND "autoDmsCounterDate" = ${since}
    `
    .catch(() => {});
}

export async function executeApproveAndSendDm(input: {
  workspaceId: string;
  socialCommentId: string;
  instagramUserId?: string | null;
  /** Optional override; otherwise AI generates both texts */
  messageOverride?: string | null;
  /** 'auto' from automation pipeline; 'manual' default */
  source?: 'auto' | 'manual';
}): Promise<ApproveDmResult> {
  const row = await prisma.socialComment.findFirst({
    where: { id: input.socialCommentId, workspaceId: input.workspaceId },
    include: { socialAccount: true },
  });
  if (!row) throw new Error('Comment not found');

  const isAuto = input.source === 'auto';
  let reservedDmSlot = false;
  let reservationSince: Date | null = null;

  if (isAuto) {
    // Atomic reservation for maxAutoDmsPerDay — this used to be a separate
    // read (count of already-sent DMs today) compared against the limit in
    // decideAutomationAction, before this function was even called. Two
    // comments on the same post classified moments apart could both read
    // the same "sent today" count — neither had sent yet — both pass the
    // check, and both send, overshooting the cap. Reserving via a
    // conditional UPDATE against the post's own settings row forces
    // Postgres to serialize concurrent reservations through that row's lock
    // instead of racing on a stale read.
    const workspace = await prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { timezone: true },
    });
    const since = startOfDayInTz(workspace?.timezone || 'Asia/Kolkata');
    reservationSince = since;
    const reserved = await prisma.$executeRaw`
      UPDATE "SocialListeningPostSetting"
      SET
        "autoDmsCounterCount" = CASE
          WHEN "autoDmsCounterDate" = ${since} THEN "autoDmsCounterCount" + 1
          ELSE 1
        END,
        "autoDmsCounterDate" = ${since}
      WHERE "workspaceId" = ${input.workspaceId} AND "postId" = ${row.postId}
        AND "maxAutoDmsPerDay" > 0
        AND (
          "autoDmsCounterDate" IS DISTINCT FROM ${since}
          OR "autoDmsCounterCount" < "maxAutoDmsPerDay"
        )
    `;
    if (reserved === 0) {
      throw new Error('Daily auto-DM cap reached for this post');
    }
    reservedDmSlot = true;
  }

  try {
    // Atomic claim — only one concurrent call for this comment may proceed
    // past this point. Closes both the double-click/manual-retry race AND
    // the Meta webhook-redelivery race, where two independent classify runs
    // for the same comment can both decide auto_dm with no user interaction
    // at all. 'pending'/'sent' are not claimable — already in flight or done.
    const claim = await prisma.socialComment.updateMany({
      where: {
        id: row.id,
        workspaceId: input.workspaceId,
        dmStatus: { in: ['none', 'failed', 'skipped'] },
      },
      data: { dmStatus: 'pending', dmError: null },
    });
    if (claim.count === 0) {
      throw new Error('This comment is already being processed or was already sent');
    }
  } catch (err) {
    if (reservedDmSlot) await releaseAutoDmReservation(input.workspaceId, row.postId, reservationSince!);
    throw err;
  }

  let publicReplyId: string | null = null;
  let publicReplyText: string;
  let dmReplyText: string;
  let dmStatus: 'sent' | 'failed' | 'skipped' = 'skipped';
  let dmError: string | null = null;
  let dmMessageId: string | null = null;
  let dmSentAt: Date | null = null;
  let settings: Awaited<ReturnType<typeof getEffectivePostSettings>>;

  try {
    settings = await getEffectivePostSettings(input.workspaceId, row.postId);
    const igUserId = input.instagramUserId || row.socialAccount?.instagramUserId;

    // A prior claim on this comment may have already posted the public
    // reply and durably checkpointed it below, then failed before finishing
    // (e.g. a DB write blip on the closing update, after Instagram already
    // has the public reply live). row.publicReplyText being set is exactly
    // that checkpoint — resume from the DM step instead of re-running
    // generation and posting a SECOND public reply to the same comment.
    if (row.publicReplyText) {
      publicReplyText = row.publicReplyText;
      dmReplyText = row.dmReplyText || '';
      console.info('[social.approve_dm] resuming after partial failure — public reply already posted', {
        socialCommentId: row.id,
        commentId: row.commentId,
      });
    } else {
      let skillInstructions: string | null = null;
      if (settings.dmAgentSkillId) {
        const skill = await prisma.aiSkill.findFirst({
          where: {
            id: settings.dmAgentSkillId,
            agent: { workspaceId: input.workspaceId },
          },
          select: { title: true, instructions: true, trigger: true },
        });
        if (skill) {
          skillInstructions = [
            `Skill: ${skill.title}`,
            skill.trigger ? `Trigger: ${skill.trigger}` : null,
            skill.instructions,
          ]
            .filter(Boolean)
            .join('\n');
        }
      }

      const texts = await generateApproveDmTexts({
        workspaceId: input.workspaceId,
        commentText: row.commentText,
        postCaption: row.postCaption,
        username: row.commenterUsername,
        suggestedReply: input.messageOverride || row.suggestedReply,
        publicReplyTone: settings.publicReplyTone,
        skillInstructions,
        fallbackMessage: settings.fallbackMessage,
      });

      publicReplyText = texts.publicReply;
      dmReplyText = input.messageOverride?.trim() || texts.dmReply;

      publicReplyId = (
        await postPublicReply(
          input.workspaceId,
          row.platform as SocialListeningPlatform,
          row.commentId,
          publicReplyText,
          igUserId
        )
      ).id;

      // Durable checkpoint, committed BEFORE attempting the DM — a failure
      // after this point resumes here on retry instead of reposting.
      await prisma.socialComment.update({
        where: { id: row.id },
        data: { publicReplyText, dmReplyText },
      });

      console.info('[social.approve_dm] public reply ok', {
        socialCommentId: row.id,
        commentId: row.commentId,
        publicReplyId,
        source: input.source || 'manual',
      });
    }

    try {
      const dm = await sendPrivateReply(
        input.workspaceId,
        row.platform as SocialListeningPlatform,
        row.commentId,
        dmReplyText,
        igUserId
      );
      dmStatus = 'sent';
      dmMessageId = dm.messageId;
      dmSentAt = new Date();
    } catch (err) {
      dmStatus = 'failed';
      dmError = (err instanceof Error ? err.message : 'Private reply failed').slice(0, 500);
      console.warn('[social.approve_dm] private reply failed (public kept)', {
        socialCommentId: row.id,
        commentId: row.commentId,
        dmError,
        source: input.source || 'manual',
      });
    }

    await prisma.socialComment.update({
      where: { id: row.id },
      data: {
        status: 'replied',
        publicReplyText,
        dmReplyText,
        dmStatus,
        dmError,
        dmSentAt,
      },
    });
  } catch (err) {
    // Release the claim on any unexpected failure (settings load, LLM
    // error, public-reply send error) so a retry isn't blocked forever by
    // a dangling 'pending' dmStatus.
    await prisma.socialComment
      .update({
        where: { id: row.id },
        data: {
          dmStatus: 'failed',
          dmError: (err instanceof Error ? err.message : 'Approve & send DM failed').slice(0, 500),
        },
      })
      .catch(() => {});
    throw err;
  } finally {
    // The reservation counts every attempt, not just sends — release it
    // whenever this attempt didn't end in an actual send, so a failed
    // auto-DM (or the settings/generation error above) doesn't permanently
    // eat into the day's quota.
    if (reservedDmSlot && dmStatus !== 'sent') {
      await releaseAutoDmReservation(input.workspaceId, row.postId, reservationSince!);
    }
  }

  const handle = row.commenterUsername ? `@${row.commenterUsername}` : 'a commenter';
  const intentLabel = mapIntentToReviewLabel(row.intent);
  const confPct =
    row.confidence != null ? `${Math.round(row.confidence * 100)}%` : null;
  const source = input.source || 'manual';

  if (source === 'auto') {
    await logSocialListeningActivity({
      workspaceId: input.workspaceId,
      eventType: 'auto_dm',
      message: `Auto-replied to ${handle} (${intentLabel}${confPct ? `, ${confPct}` : ''})`,
      relatedCommentId: row.id,
      meta: { intent: row.intent, confidence: row.confidence, dmStatus },
    });
  } else {
    await logSocialListeningActivity({
      workspaceId: input.workspaceId,
      eventType: 'manual_approve_dm',
      message: `Approved & sent DM to ${handle} (${intentLabel})`,
      relatedCommentId: row.id,
      meta: { intent: row.intent, confidence: row.confidence, dmStatus },
    });
  }

  if (dmStatus === 'sent') {
    await logSocialListeningActivity({
      workspaceId: input.workspaceId,
      eventType: 'dm_sent',
      message: `DM sent to ${handle}`,
      relatedCommentId: row.id,
      meta: { dmMessageId, source },
    });
  } else if (dmStatus === 'failed') {
    await logSocialListeningActivity({
      workspaceId: input.workspaceId,
      eventType: 'dm_failed',
      message: `DM failed for ${handle}${dmError ? ` — ${dmError.slice(0, 120)}` : ''}`,
      relatedCommentId: row.id,
      meta: { dmError, source },
    });
  }

  let leadId: string | null = null;
  const leadFunnelId = settings.leadFunnelId;
  if (
    shouldCreateLeadForIntent(settings.leadCreationRule, row.intent) &&
    leadFunnelId
  ) {
    try {
      const leadResult = await createLeadFromSocialComment({
        workspaceId: input.workspaceId,
        socialCommentId: row.id,
        funnelId: leadFunnelId,
        dmSent: dmStatus === 'sent',
      });
      leadId = leadResult.leadId;
    } catch (err) {
      console.warn('[social.approve_dm] lead create failed', {
        socialCommentId: row.id,
        error: err instanceof Error ? err.message : err,
      });
    }
  } else {
    console.info('[social.approve_dm] lead skipped by rule', {
      socialCommentId: row.id,
      leadCreationRule: settings.leadCreationRule,
      intent: row.intent,
      leadFunnelId,
      postId: row.postId,
    });
  }

  return {
    status: 'replied',
    publicReplyId,
    publicReplyText,
    dmReplyText,
    dmStatus,
    dmError,
    dmMessageId,
    leadId,
  };
}

/** Retry only the private reply (public already sent). */
export async function retryPrivateReplyDm(input: {
  workspaceId: string;
  socialCommentId: string;
  instagramUserId?: string | null;
}): Promise<{
  dmStatus: 'sent' | 'failed';
  dmError: string | null;
  dmMessageId: string | null;
  dmReplyText: string;
}> {
  const row = await prisma.socialComment.findFirst({
    where: { id: input.socialCommentId, workspaceId: input.workspaceId },
    include: { socialAccount: true },
  });
  if (!row) throw new Error('Comment not found');

  // Atomic claim — only a comment currently in 'failed' is retry-eligible.
  // Without this, two rapid "Retry DM" clicks (or a UI auto-retry racing a
  // manual one) both pass a plain read and both send the DM again.
  const claim = await prisma.socialComment.updateMany({
    where: { id: row.id, workspaceId: input.workspaceId, dmStatus: 'failed' },
    data: { dmStatus: 'pending' },
  });
  if (claim.count === 0) {
    throw new Error('This DM is already being sent or was already sent');
  }

  // Everything below runs against a row already claimed into 'pending' above.
  // Any throw here — settings lookup, skill lookup, text generation, or the
  // send itself — must land in 'failed' so the row stays retryable instead
  // of getting stuck at 'pending' forever.
  let dmReplyText = row.dmReplyText?.trim() || '';
  try {
    const settings = await getEffectivePostSettings(input.workspaceId, row.postId);

    if (!dmReplyText) {
      let skillInstructions: string | null = null;
      if (settings.dmAgentSkillId) {
        const skill = await prisma.aiSkill.findFirst({
          where: {
            id: settings.dmAgentSkillId,
            agent: { workspaceId: input.workspaceId },
          },
          select: { title: true, instructions: true, trigger: true },
        });
        if (skill) {
          skillInstructions = [
            `Skill: ${skill.title}`,
            skill.trigger ? `Trigger: ${skill.trigger}` : null,
            skill.instructions,
          ]
            .filter(Boolean)
            .join('\n');
        }
      }
      const texts = await generateApproveDmTexts({
        workspaceId: input.workspaceId,
        commentText: row.commentText,
        postCaption: row.postCaption,
        username: row.commenterUsername,
        suggestedReply: row.suggestedReply,
        publicReplyTone: settings.publicReplyTone,
        skillInstructions,
        fallbackMessage: settings.fallbackMessage,
      });
      dmReplyText = texts.dmReply;
    }

    const igUserId = input.instagramUserId || row.socialAccount?.instagramUserId;

    const dm = await sendPrivateReply(
      input.workspaceId,
      row.platform as SocialListeningPlatform,
      row.commentId,
      dmReplyText,
      igUserId
    );
    await prisma.socialComment.update({
      where: { id: row.id },
      data: {
        dmReplyText,
        dmStatus: 'sent',
        dmError: null,
        dmSentAt: new Date(),
      },
    });
    return {
      dmStatus: 'sent',
      dmError: null,
      dmMessageId: dm.messageId,
      dmReplyText,
    };
  } catch (err) {
    const dmError = (err instanceof Error ? err.message : 'Private reply failed').slice(0, 500);
    await prisma.socialComment.update({
      where: { id: row.id },
      data: {
        dmReplyText,
        dmStatus: 'failed',
        dmError,
      },
    });
    return { dmStatus: 'failed', dmError, dmMessageId: null, dmReplyText };
  }
}
