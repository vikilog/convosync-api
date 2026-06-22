import { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getJwtUser } from './auth.js';
import {
  hasWorkspacePermission,
  type WorkspacePermission,
} from '../services/workspacePermissions.js';
import { isAllowedMemberRole, type WorkspaceMemberRole } from '../services/workspaceMemberAdmin.js';

export async function loadMembershipAccess(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true, permissions: true },
  });
  const role: WorkspaceMemberRole =
    membership && isAllowedMemberRole(membership.role) ? membership.role : 'agent';
  return { role, permissions: membership?.permissions ?? [] };
}

export function requireWorkspacePermission(permission: WorkspacePermission) {
  return async function checkPermission(request: FastifyRequest, reply: FastifyReply) {
    if (reply.sent) return;

    const user = getJwtUser(request);
    if (!user?.userId || !user?.workspaceId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const access = await loadMembershipAccess(user.userId, user.workspaceId);
    if (!hasWorkspacePermission(access.role, access.permissions, permission)) {
      return reply.code(403).send({
        error: 'You do not have permission to perform this action',
        code: 'permission_denied',
        required: permission,
      });
    }
  };
}

/** Workspace admins or members with the users permission. */
export async function requireUsersManageAccess(request: FastifyRequest, reply: FastifyReply) {
  return requireWorkspacePermission('users')(request, reply);
}
