import { prisma } from '../lib/prisma.js';
import { applyConversationAssignee } from './conversation-assignee.service.js';
import {
  pickRoundRobinCandidate,
  ruleConditionsMatch,
  sortRulesForEvaluation,
  withinCapacity,
  type EligibleMember,
  type InboxRuleConditions,
} from './inboxAutoAssign.rules.js';

export * from './inboxAutoAssign.rules.js';

async function getEligibleMembers(workspaceId: string): Promise<EligibleMember[]> {
  const memberships = await prisma.workspaceMembership.findMany({
    where: {
      workspaceId,
      autoAssignEligible: true,
      OR: [{ role: 'admin' }, { permissions: { has: 'inbox' } }],
    },
    select: { id: true, userId: true, assignmentLimit: true, lastAutoAssignedAt: true },
  });
  if (memberships.length === 0) return [];

  const userIds = memberships.map((m) => m.userId);
  const counts = await prisma.conversation.groupBy({
    by: ['assignedTo'],
    where: { workspaceId, assignedTo: { in: userIds }, status: { not: 'resolved' } },
    _count: { _all: true },
  });
  const countByUser = new Map(counts.map((c) => [c.assignedTo, c._count._all] as const));

  return memberships.map((m) => ({
    membershipId: m.id,
    userId: m.userId,
    assignmentLimit: m.assignmentLimit,
    lastAutoAssignedAt: m.lastAutoAssignedAt,
    openCount: countByUser.get(m.userId) ?? 0,
  }));
}

async function resolveGroupCandidateUserId(
  groupId: string,
  pool: EligibleMember[]
): Promise<string | null> {
  const members = await prisma.inboxTeamGroupMember.findMany({
    where: { groupId },
    select: { membershipId: true },
  });
  const memberIds = new Set(members.map((m) => m.membershipId));
  const picked = pickRoundRobinCandidate(pool.filter((m) => memberIds.has(m.membershipId)));
  return picked?.userId ?? null;
}

async function assignAndBump(
  workspaceId: string,
  conversationId: string,
  userId: string
): Promise<boolean> {
  try {
    await applyConversationAssignee(
      workspaceId,
      conversationId,
      { assigneeType: 'user', assigneeId: userId },
      { actorType: 'SYSTEM', actorName: 'Auto-assign' }
    );
  } catch (err) {
    console.warn('[InboxAutoAssign] assign failed', err instanceof Error ? err.message : err);
    return false;
  }
  await prisma.workspaceMembership.updateMany({
    where: { workspaceId, userId },
    data: { lastAutoAssignedAt: new Date() },
  });
  return true;
}

/**
 * Auto-assigns a newly-inbound, unassigned conversation to a human agent.
 * Returns true if it assigned someone (caller should skip default-reply / automation).
 */
export async function tryAutoAssignInboundConversation(input: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  channel: 'whatsapp' | 'instagram' | 'messenger';
}): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { inboxAssignmentMode: true, inboxAssignmentTimezone: true, timezone: true },
  });
  if (!workspace || workspace.inboxAssignmentMode === 'off') return false;

  const conv = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    select: { assigneeType: true },
  });
  if (!conv || conv.assigneeType) return false; // already assigned — never steal

  const pool = await getEligibleMembers(input.workspaceId);
  if (pool.length === 0) return false;

  const fallbackTimezone =
    workspace.inboxAssignmentTimezone || workspace.timezone || 'Asia/Kolkata';

  if (workspace.inboxAssignmentMode === 'advanced') {
    const rules = sortRulesForEvaluation(
      await prisma.inboxAssignmentRule.findMany({ where: { workspaceId: input.workspaceId } })
    );

    if (rules.length > 0) {
      const contact = await prisma.contact.findFirst({
        where: { id: input.contactId, workspaceId: input.workspaceId },
        select: { tags: true },
      });
      const now = new Date();

      for (const rule of rules) {
        const conditions = (rule.conditions ?? {}) as unknown as InboxRuleConditions;
        if (
          !ruleConditionsMatch(conditions, {
            channel: input.channel,
            contactTags: contact?.tags ?? [],
            now,
            fallbackTimezone,
          })
        ) {
          continue;
        }

        const userId =
          rule.actionType === 'group' && rule.actionGroupId
            ? await resolveGroupCandidateUserId(rule.actionGroupId, pool)
            : rule.actionType === 'user' && rule.actionUserId
              ? (pool.find((m) => m.userId === rule.actionUserId && withinCapacity(m))?.userId ??
                null)
              : null;

        if (!userId) continue; // matched but no eligible target right now — try next rule

        return assignAndBump(input.workspaceId, input.conversationId, userId);
      }
    }
    // No enabled rule matched → fall through to Basic round-robin.
  }

  const picked = pickRoundRobinCandidate(pool);
  if (!picked) return false;
  return assignAndBump(input.workspaceId, input.conversationId, picked.userId);
}
