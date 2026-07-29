import { processAiInbound } from './ai-inbound.service.js';
import { processAiAgentInbound } from './ai-agent-inbound.service.js';
import {
  processRuleBasedFlowInbound,
  type InboundMessagingContext,
  type InboundWhatsAppContext,
} from './ruleBasedFlowEngine.js';
import { prisma } from '../index.js';

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

  if (!conversation?.assigneeType) {
    logRoute('skip — unassigned (no automation)');
    return;
  }

  if (conversation.status === 'resolved') {
    logRoute('skip — conversation resolved');
    return;
  }

  const channel = resolveInboxChannel(ctx.channel, conversation.channel);
  const routed: InboundMessagingContext = { ...ctx, channel };

  switch (conversation.assigneeType) {
    case 'user':
      logRoute('skip — assigned to human agent');
      return;

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
      logRoute('route → journey (via event bus)', { journeyId: conversation.assigneeId });
      return;

    default:
      logRoute('skip — unknown assignee type', { type: conversation.assigneeType });
  }
}

/** @deprecated Prefer routeInboundConversation — kept for existing WA webhook imports. */
export async function routeInboundWhatsApp(ctx: InboundWhatsAppContext): Promise<void> {
  return routeInboundConversation({ ...ctx, channel: ctx.channel || 'whatsapp' });
}
