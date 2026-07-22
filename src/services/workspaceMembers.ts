import { prisma } from '../index.js';

export async function listWorkspaceMemberUsers(workspaceId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });

  if (memberships.length === 0) return [];

  const userIds = memberships.map((m) => m.user.id);
  const counts = await prisma.conversation.groupBy({
    by: ['assignedTo'],
    where: { workspaceId, assignedTo: { in: userIds } },
    _count: { _all: true },
  });
  const countByUser = new Map(
    counts.map((row) => [row.assignedTo, row._count._all] as const)
  );

  return memberships.map((m) => ({
    user: m.user,
    role: m.role,
    conversationsCount: countByUser.get(m.user.id) ?? 0,
  }));
}

export async function isWorkspaceMember(workspaceId: string, userId: string) {
  const m = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  return !!m;
}
