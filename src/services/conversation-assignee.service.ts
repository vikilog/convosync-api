import { prisma } from '../lib/prisma.js';
import { initJourneyModule } from '../modules/journey/container.js';
import { initInstagramJourneyModule } from '../modules/instagram-journey/container.js';
import {
  isConversationAssigneeType,
  type ConversationAssigneePatch,
  type ConversationAssigneeType,
} from '../types/conversation-assignee.js';
import { isAiAssigneeType } from '../types/conversation-event.js';
import { isWorkspaceMember } from './workspaceMembers.js';
import { recordConversationEvent } from './conversation-event.service.js';
import type { ConversationEventActorType } from '../types/conversation-event.js';
import { seedAgentChatFromInbox } from './ai-agent-inbox-seed.service.js';
import { kickAiAgentReplyForLatestContactMessage } from './ai-agent-inbound.service.js';

export class ConversationAssigneeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationAssigneeError';
  }
}

export type AssigneeActorContext = {
  actorType: ConversationEventActorType;
  actorId?: string | null;
  actorName?: string | null;
};

export async function applyConversationAssignee(
  workspaceId: string,
  conversationId: string,
  patch: ConversationAssigneePatch,
  actor?: AssigneeActorContext,
  opts?: { requireCurrentlyUnassigned?: boolean }
): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true, contactId: true, assigneeType: true, assigneeId: true, channel: true },
  });
  if (!conv) throw new ConversationAssigneeError('Conversation not found');

  // Auto-assign's own precondition ("only steal if still unassigned") must
  // be checked against THIS read — the one the CAS write below is keyed on
  // — not against whatever the caller observed earlier. Several async steps
  // (eligible-member lookup, rule matching) can run between auto-assign's
  // own initial check and this call, during which a human could have
  // manually assigned the conversation; without this, that manual
  // assignment would be silently overwritten below.
  if (opts?.requireCurrentlyUnassigned && conv.assigneeType) {
    throw new ConversationAssigneeError('Conversation was already assigned');
  }

  const assigneeType = patch.assigneeType ?? null;
  const assigneeId = patch.assigneeId ?? null;

  if (assigneeType && !isConversationAssigneeType(assigneeType)) {
    throw new ConversationAssigneeError(`Invalid assignee type: ${assigneeType}`);
  }

  if (assigneeType === 'user') {
    if (!assigneeId) throw new ConversationAssigneeError('Select a team member');
    const ok = await isWorkspaceMember(workspaceId, assigneeId);
    if (!ok) throw new ConversationAssigneeError('Agent must belong to this company');
  }

  if (assigneeType === 'rule_based' && assigneeId) {
    const agent = await prisma.aiAgent.findFirst({
      where: { id: assigneeId, workspaceId, category: 'rule_based' },
    });
    if (!agent) throw new ConversationAssigneeError('Rule-based bot not found');
  }

  if (assigneeType === 'ai_agent') {
    if (!assigneeId) throw new ConversationAssigneeError('Select an AI agent');
    const agent = await prisma.aiAgent.findFirst({
      where: {
        id: assigneeId,
        workspaceId,
        category: { in: ['ai_agent', 'responsive'] },
        isEnabled: true,
        isPublished: true,
      },
    });
    if (!agent) {
      throw new ConversationAssigneeError('Publish the AI agent before assigning it in Inbox');
    }
  }

  if (assigneeType === 'journey' && assigneeId) {
    if (conv.channel === 'instagram') {
      const igJourney = await prisma.instagramJourney.findFirst({
        where: { id: assigneeId, workspaceId, status: 'published' },
      });
      if (!igJourney) {
        throw new ConversationAssigneeError('Published Instagram automation not found');
      }
    } else if (conv.channel === 'whatsapp' || !conv.channel) {
      const journey = await prisma.journey.findFirst({
        where: { id: assigneeId, workspaceId, status: 'published' },
      });
      if (!journey) throw new ConversationAssigneeError('Published WhatsApp automation not found');
    } else {
      throw new ConversationAssigneeError(
        'Automations are only available for WhatsApp and Instagram chats'
      );
    }
  }

  if (assigneeType === 'ai') {
    const config = await prisma.aiKnowledgeConfig.findUnique({ where: { workspaceId } });
    if (!config?.venueId) {
      throw new ConversationAssigneeError(
        'Configure AI Knowledge (venue + MongoDB) before assigning AI'
      );
    }
  }

  const assignedTo = assigneeType === 'user' ? assigneeId : null;
  const changed =
    conv.assigneeType !== assigneeType ||
    (assigneeType ? conv.assigneeId !== assigneeId : Boolean(conv.assigneeId));

  // Compare-and-swap on the assignee state we just read: two concurrent
  // requests (double-click, auto-assign racing a manual assign) must not
  // both observe `changed = true` and both fire the side effects below —
  // one of those side effects is a real outbound AI reply to the customer.
  const cas = await prisma.conversation.updateMany({
    where: {
      id: conversationId,
      workspaceId,
      assigneeType: conv.assigneeType,
      assigneeId: conv.assigneeId,
    },
    data: {
      assigneeType,
      assigneeId: assigneeType ? assigneeId : null,
      assignedTo,
    },
  });

  if (cas.count === 0) {
    const latest = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { assigneeType: true, assigneeId: true },
    });
    const alreadyDesired =
      latest &&
      latest.assigneeType === assigneeType &&
      (assigneeType ? latest.assigneeId === assigneeId : !latest.assigneeId);
    if (!alreadyDesired) {
      throw new ConversationAssigneeError(
        'Conversation was reassigned by someone else — refresh and try again'
      );
    }
    // Another concurrent request already applied this exact assignment —
    // treat as success without repeating the side effects below.
    return;
  }

  if (changed && isAiAssigneeType(assigneeType)) {
    let actorName = actor?.actorName ?? null;
    if (assigneeType === 'ai_agent' && assigneeId && !actorName) {
      const agent = await prisma.aiAgent.findFirst({
        where: { id: assigneeId, workspaceId },
        select: { name: true },
      });
      actorName = agent?.name ?? 'AI Agent';
    } else if (assigneeType === 'ai' && !actorName) {
      actorName = 'AI Copilot';
    }

    await recordConversationEvent({
      conversationId,
      workspaceId,
      type: 'AI_ASSIGNED',
      actorType: actor?.actorType ?? 'SYSTEM',
      actorId: actor?.actorId ?? (assigneeType === 'ai_agent' ? assigneeId : null),
      actorName: actor?.actorName ?? actorName,
      metadata: {
        assigneeType,
        assigneeId,
      },
    });

    // Seed hybrid agent chat with inbox history so the next reply has context.
    if (assigneeType === 'ai_agent' && assigneeId) {
      await seedAgentChatFromInbox({
        workspaceId,
        agentId: assigneeId,
        inboxConversationId: conversationId,
      }).catch((err) =>
        console.warn('[AiAgentSeed] assign-time seed failed', err instanceof Error ? err.message : err)
      );

      // Reply to the latest customer message immediately (don't wait for a new webhook).
      void kickAiAgentReplyForLatestContactMessage(workspaceId, conversationId).catch((err) =>
        console.warn(
          '[AiAgentInbound] kick after assign failed',
          err instanceof Error ? err.message : err
        )
      );
    }
  }

  if (assigneeType === 'journey' && assigneeId) {
    if (conv.channel === 'instagram') {
      const { triggerService } = initInstagramJourneyModule(prisma);
      await triggerService.startPublishedJourney(workspaceId, assigneeId, conv.contactId);
    } else {
      const { triggerService } = initJourneyModule(prisma);
      await triggerService.startAssignedJourney(workspaceId, assigneeId, conv.contactId);
    }
  }

  if (assigneeType === 'rule_based' && assigneeId) {
    await prisma.agentFlowSession.deleteMany({ where: { conversationId } }).catch(() => undefined);
  }
}

export function formatAssigneeLabel(
  assigneeType: string | null | undefined,
  _assigneeId?: string | null,
  agentName?: string | null
): string {
  switch (assigneeType as ConversationAssigneeType | null | undefined) {
    case 'user':
      return agentName ?? 'Team member';
    case 'ai':
      return 'AI Copilot';
    case 'ai_agent':
      return agentName ?? 'AI Agent';
    case 'rule_based':
      return agentName ?? 'Rule-based bot';
    case 'journey':
      return 'Journey';
    default:
      return 'Unassigned';
  }
}
