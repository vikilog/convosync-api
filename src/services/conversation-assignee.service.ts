import { prisma } from '../index.js';
import { initJourneyModule } from '../modules/journey/container.js';
import {
  isConversationAssigneeType,
  type ConversationAssigneePatch,
  type ConversationAssigneeType,
} from '../types/conversation-assignee.js';
import { isWorkspaceMember } from './workspaceMembers.js';

export class ConversationAssigneeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationAssigneeError';
  }
}

export async function applyConversationAssignee(
  workspaceId: string,
  conversationId: string,
  patch: ConversationAssigneePatch
): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true, contactId: true },
  });
  if (!conv) throw new ConversationAssigneeError('Conversation not found');

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

  if (assigneeType === 'journey' && assigneeId) {
    const journey = await prisma.journey.findFirst({
      where: { id: assigneeId, workspaceId, status: 'published' },
    });
    if (!journey) throw new ConversationAssigneeError('Published journey not found');
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

  await prisma.conversation.updateMany({
    where: { id: conversationId, workspaceId },
    data: {
      assigneeType,
      assigneeId: assigneeType ? assigneeId : null,
      assignedTo,
    },
  });

  if (assigneeType === 'journey' && assigneeId) {
    const { triggerService } = initJourneyModule(prisma);
    await triggerService.startAssignedJourney(workspaceId, assigneeId, conv.contactId);
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
    case 'rule_based':
      return 'Rule-based bot';
    case 'journey':
      return 'Journey';
    default:
      return 'Unassigned';
  }
}
