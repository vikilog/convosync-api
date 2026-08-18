import { processAiInbound } from './ai-inbound.service.js';
import { processAiAgentInbound } from './ai-agent-inbound.service.js';
import {
  processRuleBasedFlowInbound,
  type InboundMessagingContext,
  type InboundWhatsAppContext,
} from './ruleBasedFlowEngine.js';
import { prisma } from '../index.js';
import { eventBus } from '../modules/journey/events/event-bus.js';
import { isWorkspaceAutomationsPaused } from './workspaceAutomationSettings.service.js';
import { maybeSendDefaultReply } from './defaultReply.service.js';
import { tryAutoAssignInboundConversation } from './inboxAutoAssign.service.js';

function logRoute(label: string, payload?: unknown) {
  const prefix = '[InboundRouter]';
  if (payload === undefined) {
    console.log(`${prefix} ${label}`);
    return;
  }
  console.log(`${prefix} ${label}`, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function resolveInboxChannel(
  ctxChannel: InboundMessagingContext['channel'],
  conversationChannel: string | null | undefined
): 'whatsapp' | 'instagram' | 'messenger' {
  if (ctxChannel === 'instagram' || ctxChannel === 'messenger' || ctxChannel === 'whatsapp') {
    return ctxChannel;
  }
  if (conversationChannel === 'instagram' || conversationChannel === 'messenger') {
    return conversationChannel;
  }
  return 'whatsapp';
}

/**
 * Routes inbound inbox messages (WhatsApp / Instagram / Messenger) based on assignment.
 * Automation runs only when a handler is explicitly assigned.
 */
export async function routeInboundConversation(ctx: InboundMessagingContext): Promise<void> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
    select: { assigneeType: true, assigneeId: true, status: true, channel: true },
  });

  if (conversation?.status === 'resolved') {
    logRoute('skip — conversation resolved');
    return;
  }

  const channel = resolveInboxChannel(ctx.channel, conversation?.channel);
  const routed: InboundMessagingContext = { ...ctx, channel };

  if (!conversation?.assigneeType) {
    const autoAssigned = await tryAutoAssignInboundConversation({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      channel,
    });
    if (autoAssigned) {
      logRoute('unassigned — auto-assigned to human agent');
      return;
    }

    logRoute('unassigned — try default reply');
    await maybeSendDefaultReply({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      channel,
    });
    return;
  }

  if (conversation.assigneeType === 'user') {
    logRoute('skip — assigned to human agent');
    return;
  }

  // Kill switch: pause journeys / bots / AI auto-replies
  if (await isWorkspaceAutomationsPaused(ctx.workspaceId)) {
    logRoute('skip — workspace automations paused', {
      assigneeType: conversation.assigneeType,
    });
    return;
  }

  switch (conversation.assigneeType) {
    case 'ai':
      logRoute('route → AI Copilot', { channel });
      await processAiInbound(routed);
      return;

    case 'ai_agent':
      logRoute('route → AI Agent', { agentId: conversation.assigneeId, channel });
      await processAiAgentInbound(routed);
      return;

    case 'rule_based':
      logRoute('route → rule-based bot', { agentId: conversation.assigneeId, channel });
      await processRuleBasedFlowInbound({
        ...routed,
        forcedAgentId: conversation.assigneeId ?? undefined,
      });
      return;

    case 'journey':
      logRoute('route → journey (via event bus)', {
        journeyId: conversation.assigneeId,
        channel,
      });
      // Instagram automations start from IG webhook (assign + keyword). Don't fan into WA journeys.
      if (channel === 'instagram') {
        logRoute('skip — Instagram automation handled by IG journey trigger');
        return;
      }
      void eventBus.emit('message.received', {
        workspaceId: ctx.workspaceId,
        event: 'message.received',
        contactId: ctx.contactId,
        payload: {
          text: ctx.text,
          buttonPayload: ctx.buttonPayload,
          conversationId: ctx.conversationId,
          channel,
          messageId: ctx.messageId,
        },
      });
      return;

    default:
      logRoute('skip — unknown assignee type', { type: conversation.assigneeType });
  }
}

/** @deprecated Prefer routeInboundConversation — kept for existing WA webhook imports. */
export async function routeInboundWhatsApp(ctx: InboundWhatsAppContext): Promise<void> {
  return routeInboundConversation({ ...ctx, channel: ctx.channel || 'whatsapp' });
}
