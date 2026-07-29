import { prisma } from '../index.js';
import { AiProviderConfigService } from '../modules/ai-agent/services/ai-provider-config.service.js';
import { LlmClient } from '../modules/ai-agent/services/llm-client.service.js';
import {
  replyToListeningComment,
  sendPrivateReplyToComment,
} from './instagramListening.service.js';
import { createLeadFromSocialComment } from './lead.service.js';
import {
  shouldCreateLeadForIntent,
  type ReplyTone,
} from './socialListeningSettings.service.js';
import {
  getEffectivePostSettings,
} from './socialListeningPostSetting.service.js';
import { logSocialListeningActivity } from './socialListeningActivity.service.js';
import { mapIntentToReviewLabel } from './socialCommentClassify.service.js';

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

  const systemPrompt = `You help a brand respond to an Instagram comment.

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

  const settings = await getEffectivePostSettings(input.workspaceId, row.postId);

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

  const igUserId = input.instagramUserId || row.socialAccount.instagramUserId;
  const publicReplyText = texts.publicReply;
  const dmReplyText = input.messageOverride?.trim() || texts.dmReply;

  await prisma.socialComment.update({
    where: { id: row.id },
    data: {
      dmStatus: 'pending',
      dmError: null,
      publicReplyText,
      dmReplyText,
    },
  });

  let publicReplyId: string | null = null;
  publicReplyId = (
    await replyToListeningComment(input.workspaceId, row.commentId, publicReplyText, igUserId)
  ).id;

  console.info('[social.approve_dm] public reply ok', {
    socialCommentId: row.id,
    commentId: row.commentId,
    publicReplyId,
    source: input.source || 'manual',
  });

  let dmStatus: 'sent' | 'failed' | 'skipped' = 'skipped';
  let dmError: string | null = null;
  let dmMessageId: string | null = null;
  let dmSentAt: Date | null = null;

  try {
    const dm = await sendPrivateReplyToComment(
      input.workspaceId,
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

  const settings = await getEffectivePostSettings(input.workspaceId, row.postId);

  let dmReplyText = row.dmReplyText?.trim() || '';
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

  const igUserId = input.instagramUserId || row.socialAccount.instagramUserId;

  try {
    const dm = await sendPrivateReplyToComment(
      input.workspaceId,
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
