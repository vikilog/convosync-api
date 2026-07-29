/**
 * Wraps media/send-media.service.ts `planAgentMediaAttachment` + media-offer helpers
 * (same shaping as ConversationService.replyFromMediaPlan).
 */
import {
  isMediaCapabilityRefusal,
  mediaNoMatchReply,
  mediaSendAck,
  shouldAutoSendMedia,
  shouldConsiderMediaAttachment,
} from '../../media/media-offer.js';
import { planAgentMediaAttachment } from '../../media/send-media.service.js';
import type { AgentGraphStateType, GraphMediaAttachment } from '../state.js';

export async function attachMediaNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  const intent = state.intent || 'unknown';
  if (state.fromCache || !shouldConsiderMediaAttachment(intent, state.message)) {
    return { mediaAttachment: { action: 'none' } };
  }

  const mediaConvId = state.mediaConversationId || state.conversationId;
  const preview = state.channel === 'preview';
  let reply = state.reply || '';

  try {
    const plan = await planAgentMediaAttachment({
      workspaceId: state.workspaceId,
      conversationId: mediaConvId,
      query: state.message,
      intent,
      audience: 'customer',
    });

    let mediaAttachment: GraphMediaAttachment = { action: 'none' };

    if (plan.kind === 'send') {
      const title = plan.asset.title;
      if (preview) {
        reply = `${reply || mediaSendAck(title)}\n\n📎 Will send on WhatsApp: ${title} (${plan.asset.type})`;
      } else if (!reply) {
        reply = mediaSendAck(title);
      }
      mediaAttachment = {
        action: 'send',
        mediaId: plan.asset.id,
        title,
        type: plan.asset.type,
      };
    } else if (plan.kind === 'offer') {
      reply = reply ? `${reply}\n\n${plan.offerLine}` : plan.offerLine;
      mediaAttachment = {
        action: 'offer',
        mediaId: plan.asset.id,
        title: plan.asset.title,
        type: plan.asset.type,
        offerLine: plan.offerLine,
      };
    } else if (!reply.trim() && shouldAutoSendMedia(intent)) {
      // Explicit media/pricing ask with no gallery hit — clarify, do not escalate.
      reply = mediaNoMatchReply();
    }

    if (isMediaCapabilityRefusal(reply) && mediaAttachment.action !== 'none') {
      reply =
        mediaAttachment.action === 'send'
          ? mediaSendAck(mediaAttachment.title)
          : mediaAttachment.offerLine;
    }

    return { reply, mediaAttachment };
  } catch (err) {
    console.warn(
      '[agent-graph] attach_media failed',
      err instanceof Error ? err.message : err
    );
    return { mediaAttachment: { action: 'none' } };
  }
}
