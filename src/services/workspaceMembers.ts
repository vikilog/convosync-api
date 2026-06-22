import { prisma } from '../index.js';

export async function listWorkspaceMemberUsers(workspaceId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });

  return Promise.all(
    memberships.map(async (m) => {
      const conversationsCount = await prisma.conversation.count({
        where: { workspaceId, assignedTo: m.user.id },
      });
      return {
        user: m.user,
        role: m.role,
        conversationsCount,
      };
    })
  );
}

export async function isWorkspaceMember(workspaceId: string, userId: string) {
  const m = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  return !!m;
}
