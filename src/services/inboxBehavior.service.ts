import { prisma } from '../lib/prisma.js';
import type { InboxAssignmentMode, InboxRuleConditions } from './inboxAutoAssign.rules.js';

const MODES: InboxAssignmentMode[] = ['off', 'basic', 'advanced'];
export function isInboxAssignmentMode(value: string): value is InboxAssignmentMode {
  return (MODES as string[]).includes(value);
}

export async function getInboxBehaviorSettings(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { inboxAssignmentMode: true, inboxAssignmentTimezone: true, timezone: true },
  });
  if (!workspace) return null;
  return {
    mode: workspace.inboxAssignmentMode as InboxAssignmentMode,
    timezone: workspace.inboxAssignmentTimezone,
    effectiveTimezone: workspace.inboxAssignmentTimezone || workspace.timezone || 'Asia/Kolkata',
  };
}

export async function updateInboxBehaviorSettings(
  workspaceId: string,
  patch: { mode?: InboxAssignmentMode; timezone?: string | null }
) {
  const data: Record<string, unknown> = {};
  if (patch.mode) data.inboxAssignmentMode = patch.mode;
  if (patch.timezone !== undefined) data.inboxAssignmentTimezone = patch.timezone?.trim() || null;

  await prisma.workspace.update({ where: { id: workspaceId }, data });
  return getInboxBehaviorSettings(workspaceId);
}

function formatGroup(group: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{
    membershipId: string;
    membership: { id: string; userId: string; user: { name: string; email: string } };
  }>;
}) {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    members: group.members.map((m) => ({
      membershipId: m.membershipId,
      userId: m.membership.userId,
      name: m.membership.user.name,
      email: m.membership.user.email,
    })),
  };
}

const groupInclude = {
  members: {
    include: { membership: { include: { user: { select: { name: true, email: true } } } } },
  },
} as const;

export async function listInboxGroups(workspaceId: string) {
  const groups = await prisma.inboxTeamGroup.findMany({
    where: { workspaceId },
    include: groupInclude,
    orderBy: { createdAt: 'asc' },
  });
  return groups.map(formatGroup);
}

export async function createInboxGroup(workspaceId: string, name: string) {
  const group = await prisma.inboxTeamGroup.create({
    data: { workspaceId, name: name.trim() },
    include: groupInclude,
  });
  return formatGroup(group);
}

export async function updateInboxGroup(workspaceId: string, groupId: string, name: string) {
  const existing = await prisma.inboxTeamGroup.findFirst({ where: { id: groupId, workspaceId } });
  if (!existing) throw new Error('Group not found');
  const group = await prisma.inboxTeamGroup.update({
    where: { id: groupId },
    data: { name: name.trim() },
    include: groupInclude,
  });
  return formatGroup(group);
}

export async function deleteInboxGroup(workspaceId: string, groupId: string) {
  const existing = await prisma.inboxTeamGroup.findFirst({ where: { id: groupId, workspaceId } });
  if (!existing) throw new Error('Group not found');
  await prisma.inboxTeamGroup.delete({ where: { id: groupId } });
  return { success: true };
}

export async function addInboxGroupMember(
  workspaceId: string,
  groupId: string,
  membershipId: string
) {
  const group = await prisma.inboxTeamGroup.findFirst({ where: { id: groupId, workspaceId } });
  if (!group) throw new Error('Group not found');
  const membership = await prisma.workspaceMembership.findFirst({
    where: { id: membershipId, workspaceId },
  });
  if (!membership) throw new Error('Team member not found');

  await prisma.inboxTeamGroupMember.upsert({
    where: { groupId_membershipId: { groupId, membershipId } },
    create: { groupId, membershipId },
    update: {},
  });
  const updated = await prisma.inboxTeamGroup.findUniqueOrThrow({
    where: { id: groupId },
    include: groupInclude,
  });
  return formatGroup(updated);
}

export async function removeInboxGroupMember(
  workspaceId: string,
  groupId: string,
  membershipId: string
) {
  const group = await prisma.inboxTeamGroup.findFirst({ where: { id: groupId, workspaceId } });
  if (!group) throw new Error('Group not found');
  await prisma.inboxTeamGroupMember
    .delete({ where: { groupId_membershipId: { groupId, membershipId } } })
    .catch(() => undefined);
  const updated = await prisma.inboxTeamGroup.findUniqueOrThrow({
    where: { id: groupId },
    include: groupInclude,
  });
  return formatGroup(updated);
}

export type InboxRuleInput = {
  name: string;
  enabled?: boolean;
  conditions: InboxRuleConditions;
  actionType: 'group' | 'user';
  actionGroupId?: string | null;
  actionUserId?: string | null;
};

async function assertRuleActionValid(workspaceId: string, input: InboxRuleInput) {
  if (input.actionType === 'group') {
    if (!input.actionGroupId) throw new Error('Select a group');
    const group = await prisma.inboxTeamGroup.findFirst({
      where: { id: input.actionGroupId, workspaceId },
    });
    if (!group) throw new Error('Group not found');
  } else {
    if (!input.actionUserId) throw new Error('Select a team member');
    const membership = await prisma.workspaceMembership.findFirst({
      where: { workspaceId, userId: input.actionUserId },
    });
    if (!membership) throw new Error('Team member not found');
  }
}

export async function listInboxRules(workspaceId: string) {
  return prisma.inboxAssignmentRule.findMany({
    where: { workspaceId },
    orderBy: { priority: 'asc' },
  });
}

export async function createInboxRule(workspaceId: string, input: InboxRuleInput) {
  await assertRuleActionValid(workspaceId, input);
  const maxPriority = await prisma.inboxAssignmentRule.aggregate({
    where: { workspaceId },
    _max: { priority: true },
  });
  return prisma.inboxAssignmentRule.create({
    data: {
      workspaceId,
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      priority: (maxPriority._max.priority ?? -1) + 1,
      conditions: input.conditions,
      actionType: input.actionType,
      actionGroupId: input.actionType === 'group' ? input.actionGroupId : null,
      actionUserId: input.actionType === 'user' ? input.actionUserId : null,
    },
  });
}

export async function updateInboxRule(
  workspaceId: string,
  ruleId: string,
  input: Partial<InboxRuleInput>
) {
  const existing = await prisma.inboxAssignmentRule.findFirst({
    where: { id: ruleId, workspaceId },
  });
  if (!existing) throw new Error('Rule not found');

  const merged: InboxRuleInput = {
    name: input.name ?? existing.name,
    enabled: input.enabled ?? existing.enabled,
    conditions: input.conditions ?? ((existing.conditions ?? {}) as InboxRuleConditions),
    actionType: input.actionType ?? (existing.actionType as 'group' | 'user'),
    actionGroupId: input.actionGroupId !== undefined ? input.actionGroupId : existing.actionGroupId,
    actionUserId: input.actionUserId !== undefined ? input.actionUserId : existing.actionUserId,
  };
  await assertRuleActionValid(workspaceId, merged);

  return prisma.inboxAssignmentRule.update({
    where: { id: ruleId },
    data: {
      name: merged.name.trim(),
      enabled: merged.enabled,
      conditions: merged.conditions,
      actionType: merged.actionType,
      actionGroupId: merged.actionType === 'group' ? merged.actionGroupId : null,
      actionUserId: merged.actionType === 'user' ? merged.actionUserId : null,
    },
  });
}

export async function deleteInboxRule(workspaceId: string, ruleId: string) {
  const existing = await prisma.inboxAssignmentRule.findFirst({
    where: { id: ruleId, workspaceId },
  });
  if (!existing) throw new Error('Rule not found');
  await prisma.inboxAssignmentRule.delete({ where: { id: ruleId } });
  return { success: true };
}

/** `orderedIds` — full list of this workspace's rule ids in the desired evaluation order. */
export async function reorderInboxRules(workspaceId: string, orderedIds: string[]) {
  const rules = await prisma.inboxAssignmentRule.findMany({
    where: { workspaceId },
    select: { id: true },
  });
  const validIds = new Set(rules.map((r) => r.id));
  const filtered = orderedIds.filter((id) => validIds.has(id));
  if (filtered.length !== rules.length) {
    throw new Error('Reorder list must include every rule exactly once');
  }

  await prisma.$transaction(
    filtered.map((id, index) =>
      prisma.inboxAssignmentRule.update({ where: { id }, data: { priority: index } })
    )
  );
  return listInboxRules(workspaceId);
}
