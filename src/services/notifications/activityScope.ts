import type { Prisma } from '@prisma/client';

export type ActivityViewerRole = 'admin' | 'agent';

/**
 * Activity feed scope (not the bell inbox).
 * admin → whole workspace; agent → actor self or targeted to self.
 */
export function activityWhereForRole(input: {
  workspaceId: string;
  userId: string;
  role: ActivityViewerRole;
}): Prisma.WorkspaceNotificationWhereInput {
  if (input.role === 'admin') {
    return { workspaceId: input.workspaceId };
  }
  return {
    workspaceId: input.workspaceId,
    OR: [{ actorUserId: input.userId }, { targetUserId: input.userId }],
  };
}

/** Normalize unknown role strings to activity viewer role. */
export function normalizeActivityRole(role: string | null | undefined): ActivityViewerRole {
  return role === 'admin' ? 'admin' : 'agent';
}
