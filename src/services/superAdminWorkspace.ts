import { prisma } from '../lib/prisma.js';

export type SuperAdminWorkspaceSnapshot = {
  isSuperAdmin: boolean;
};

export async function getSuperAdminWorkspaceSnapshot(
  workspaceId: string
): Promise<SuperAdminWorkspaceSnapshot | null> {
  return prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { isSuperAdmin: true },
  });
}

export async function isSuperAdminWorkspace(workspaceId: string): Promise<boolean> {
  const workspace = await getSuperAdminWorkspaceSnapshot(workspaceId);
  return workspace?.isSuperAdmin === true;
}
