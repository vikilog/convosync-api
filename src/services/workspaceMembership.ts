import {
  getCachedWorkspaceAccess,
  setCachedWorkspaceAccess,
} from '../lib/workspaceAccessCache.js';
import { prisma } from '../index.js';

export async function ensureUserMemberships(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const count = await prisma.workspaceMembership.count({ where: { userId } });
  if (count > 0) return;

  await prisma.workspaceMembership.create({
    data: {
      userId,
      workspaceId: user.workspaceId,
      role: user.role,
    },
  });
}

export async function listUserWorkspaces(userId: string) {
  await ensureUserMemberships(userId);
  const rows = await prisma.workspaceMembership.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { workspace: { name: 'asc' } },
  });
  return rows.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    role: m.role,
    waPhoneNumber: m.workspace.waPhoneNumber,
    createdAt: m.workspace.createdAt,
  }));
}

export async function userHasWorkspaceAccess(userId: string, workspaceId: string) {
  if ((await getCachedWorkspaceAccess(userId, workspaceId)) === true) return true;

  let m = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!m) {
    // Legacy users with a User.workspaceId but no membership row.
    await ensureUserMemberships(userId);
    m = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
  }
  if (m) await setCachedWorkspaceAccess(userId, workspaceId);
  return !!m;
}
