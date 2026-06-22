import { processAiInbound } from './ai-inbound.service.js';
import {
  processRuleBasedFlowInbound,
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

/**
 * Routes inbound WhatsApp messages based on inbox assignment.
 * Automation runs only when a handler is explicitly assigned.
 */
export async function routeInboundWhatsApp(ctx: InboundWhatsAppContext): Promise<void> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, workspaceId: ctx.workspaceId },
    select: { assigneeType: true, assigneeId: true, status: true },
  });

  if (!conversation?.assigneeType) {
    logRoute('skip — unassigned (no automation)');
    return;
  }

  if (conversation.status === 'resolved') {
    logRoute('skip — conversation resolved');
    return;
  }

  switch (conversation.assigneeType) {
    case 'user':
      logRoute('skip — assigned to human agent');
      return;

    case 'ai':
      logRoute('route → AI Copilot');
      await processAiInbound(ctx);
      return;

    case 'rule_based':
      logRoute('route → rule-based bot', { agentId: conversation.assigneeId });
      await processRuleBasedFlowInbound({
        ...ctx,
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
