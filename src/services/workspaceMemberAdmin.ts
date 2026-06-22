import bcrypt from 'bcryptjs';
import { prisma } from '../index.js';
import { isSuperAdminWorkspace } from './superAdminWorkspace.js';
import {
  normalizePermissions,
  resolveEffectivePermissions,
  type WorkspacePermission,
} from './workspacePermissions.js';
import {
  FULL_INBOX_SCOPE,
  inboxScopeForStorage,
  inboxScopesEqual,
  parseInboxScope,
  resolveEffectiveInboxScope,
  resolveInboxScopeForMember,
  validateInboxScopeForWorkspace,
  type InboxScope,
} from './inboxScope.js';

export type WorkspaceMemberRole = 'admin' | 'agent';

const ALLOWED_ROLES: WorkspaceMemberRole[] = ['admin', 'agent'];

export function isAllowedMemberRole(role: string): role is WorkspaceMemberRole {
  return ALLOWED_ROLES.includes(role as WorkspaceMemberRole);
}

export async function resolveMembershipRole(
  userId: string,
  workspaceId: string
): Promise<WorkspaceMemberRole> {
  const access = await resolveMembershipAccess(userId, workspaceId);
  return access.role;
}

export async function resolveMembershipAccess(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true, permissions: true, inboxScope: true },
  });
  const role: WorkspaceMemberRole =
    membership && isAllowedMemberRole(membership.role) ? membership.role : 'agent';
  const permissions = resolveEffectivePermissions(role, membership?.permissions ?? []);
  const inboxScope = resolveInboxScopeForMember({
    role,
    permissions,
    inboxScope: membership?.inboxScope,
  });
  return {
    role,
    permissions,
    inboxScope,
    rawPermissions: membership?.permissions ?? [],
    rawInboxScope: membership?.inboxScope ?? null,
  };
}

async function assertTeamSeatAvailable(workspaceId: string) {
  if (await isSuperAdminWorkspace(workspaceId)) return;

  const [limits, memberCount] = await Promise.all([
    prisma.workspaceUsageLimits.findUnique({
      where: { workspaceId },
      select: { teamMembersLimit: true },
    }),
    prisma.workspaceMembership.count({ where: { workspaceId } }),
  ]);
  const cap = limits?.teamMembersLimit ?? 2;
  if (memberCount >= cap) {
    throw new Error(
      `Team member limit reached (${cap}). Upgrade your plan or remove a member to add more users.`
    );
  }
}

async function countWorkspaceAdmins(workspaceId: string) {
  return prisma.workspaceMembership.count({
    where: { workspaceId, role: 'admin' },
  });
}

export async function getWorkspaceOwnerUserId(workspaceId: string) {
  const owner = await prisma.user.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return owner?.id ?? null;
}

export function formatWorkspaceMember(m: {
  id: string;
  role: string;
  permissions: string[];
  inboxScope?: unknown;
  createdAt: Date;
  user: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
    createdAt: Date;
  };
}, ownerUserId: string | null) {
  const permissions =
    m.role === 'admin'
      ? resolveEffectivePermissions('admin', [])
      : resolveEffectivePermissions('agent', m.permissions);
  const inboxScope = resolveInboxScopeForMember({
    role: m.role as WorkspaceMemberRole,
    permissions,
    inboxScope: m.inboxScope,
  });

  return {
    id: m.id,
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    permissions,
    inboxScope,
    avatar: m.user.avatar,
    status: 'active',
    isOwner: ownerUserId === m.user.id,
    joinedAt: m.createdAt,
  };
}

export async function listWorkspaceMembersFormatted(workspaceId: string) {
  const [memberships, ownerUserId] = await Promise.all([
    prisma.workspaceMembership.findMany({
      where: { workspaceId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    getWorkspaceOwnerUserId(workspaceId),
  ]);

  return memberships.map((m) => formatWorkspaceMember(m, ownerUserId));
}

async function resolveMemberInboxScope(input: {
  workspaceId: string;
  role: WorkspaceMemberRole;
  permissions: WorkspacePermission[];
  inboxScope?: unknown;
}): Promise<InboxScope | null> {
  if (input.role === 'admin') return null;
  if (!input.permissions.includes('inbox')) return null;
  if (input.inboxScope === undefined || input.inboxScope === null) return null;
  return validateInboxScopeForWorkspace(input.workspaceId, input.inboxScope);
}

export async function addWorkspaceMember(input: {
  workspaceId: string;
  email: string;
  name?: string;
  password?: string;
  role: WorkspaceMemberRole;
  permissions?: WorkspacePermission[];
  inboxScope?: unknown;
}) {
  await assertTeamSeatAvailable(input.workspaceId);

  const email = input.email.trim().toLowerCase();
  const permissions =
    input.role === 'admin' ? [] : normalizePermissions(input.permissions ?? []);
  const validatedInboxScope = await resolveMemberInboxScope({
    workspaceId: input.workspaceId,
    role: input.role,
    permissions,
    inboxScope: input.inboxScope,
  });
  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    const existingMembership = await prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: { userId: existingUser.id, workspaceId: input.workspaceId },
      },
    });
    if (existingMembership) {
      throw new Error('This user is already a member of this company');
    }

    const membership = await prisma.workspaceMembership.create({
      data: {
        userId: existingUser.id,
        workspaceId: input.workspaceId,
        role: input.role,
        permissions,
        inboxScope: inboxScopeForStorage(validatedInboxScope),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
            createdAt: true,
          },
        },
      },
    });

    const ownerUserId = await getWorkspaceOwnerUserId(input.workspaceId);
    return {
      member: formatWorkspaceMember(membership, ownerUserId),
      createdUser: false,
    };
  }

  const name = input.name?.trim();
  const password = input.password?.trim();
  if (!name || name.length < 2) {
    throw new Error('Name is required when inviting a new user');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters for new users');
  }

  const user = await prisma.user.create({
    data: {
      name,
      email,
      password: await bcrypt.hash(password, 12),
      role: input.role,
      workspaceId: input.workspaceId,
      memberships: {
        create: {
          workspaceId: input.workspaceId,
          role: input.role,
          permissions,
          inboxScope: inboxScopeForStorage(validatedInboxScope),
        },
      },
    },
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
      createdAt: true,
    },
  });

  const membership = await prisma.workspaceMembership.findUniqueOrThrow({
    where: {
      userId_workspaceId: { userId: user.id, workspaceId: input.workspaceId },
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          createdAt: true,
        },
      },
    },
  });

  const ownerUserId = await getWorkspaceOwnerUserId(input.workspaceId);
  return {
    member: formatWorkspaceMember(membership, ownerUserId),
    createdUser: true,
  };
}

export async function updateWorkspaceMember(input: {
  workspaceId: string;
  membershipId: string;
  role: WorkspaceMemberRole;
  permissions?: WorkspacePermission[];
  inboxScope?: unknown;
}) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { id: input.membershipId, workspaceId: input.workspaceId },
    include: { user: true },
  });
  if (!membership) {
    throw new Error('Member not found');
  }

  const nextRole = input.role;
  const nextPermissions =
    nextRole === 'admin' ? [] : normalizePermissions(input.permissions ?? membership.permissions);

  const currentEffectiveScope = resolveInboxScopeForMember({
    role: membership.role as WorkspaceMemberRole,
    permissions: resolveEffectivePermissions(
      membership.role as WorkspaceMemberRole,
      membership.permissions
    ),
    inboxScope: membership.inboxScope,
  });

  let nextValidatedInboxScope: InboxScope | null = null;
  if (nextRole === 'admin') {
    nextValidatedInboxScope = null;
  } else if (!nextPermissions.includes('inbox')) {
    nextValidatedInboxScope = null;
  } else if (input.inboxScope !== undefined) {
    nextValidatedInboxScope = await resolveMemberInboxScope({
      workspaceId: input.workspaceId,
      role: nextRole,
      permissions: nextPermissions,
      inboxScope: input.inboxScope,
    });
  } else if (membership.inboxScope) {
    nextValidatedInboxScope = await validateInboxScopeForWorkspace(
      input.workspaceId,
      membership.inboxScope
    );
  } else {
    nextValidatedInboxScope = null;
  }

  const nextEffectiveScope =
    nextRole === 'admin' || !nextPermissions.includes('inbox')
      ? FULL_INBOX_SCOPE
      : nextValidatedInboxScope
        ? resolveEffectiveInboxScope(nextRole, nextValidatedInboxScope)
        : FULL_INBOX_SCOPE;

  const roleChanged = membership.role !== nextRole;
  const permissionsChanged =
    nextRole !== 'admin' &&
    JSON.stringify(normalizePermissions(membership.permissions)) !==
      JSON.stringify(nextPermissions);
  const inboxScopeChanged = !inboxScopesEqual(currentEffectiveScope, nextEffectiveScope);

  if (!roleChanged && !permissionsChanged && !inboxScopeChanged) {
    const ownerUserId = await getWorkspaceOwnerUserId(input.workspaceId);
    return formatWorkspaceMember(membership, ownerUserId);
  }

  if (membership.role === 'admin' && nextRole !== 'admin') {
    const adminCount = await countWorkspaceAdmins(input.workspaceId);
    if (adminCount <= 1) {
      throw new Error('Cannot change role of the last admin');
    }
  }

  const updated = await prisma.workspaceMembership.update({
    where: { id: membership.id },
    data: {
      role: nextRole,
      permissions: nextPermissions,
      inboxScope: inboxScopeForStorage(nextValidatedInboxScope),
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          avatar: true,
          createdAt: true,
        },
      },
    },
  });

  if (roleChanged && membership.user.workspaceId === input.workspaceId) {
    await prisma.user.update({
      where: { id: membership.user.id },
      data: { role: nextRole },
    });
  }

  const ownerUserId = await getWorkspaceOwnerUserId(input.workspaceId);
  return formatWorkspaceMember(updated, ownerUserId);
}

/** @deprecated Use updateWorkspaceMember */
export async function updateWorkspaceMemberRole(input: {
  workspaceId: string;
  membershipId: string;
  role: WorkspaceMemberRole;
}) {
  return updateWorkspaceMember(input);
}

export async function removeWorkspaceMember(input: {
  workspaceId: string;
  membershipId: string;
  actorUserId: string;
}) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { id: input.membershipId, workspaceId: input.workspaceId },
    include: { user: true },
  });
  if (!membership) {
    throw new Error('Member not found');
  }

  const ownerUserId = await getWorkspaceOwnerUserId(input.workspaceId);
  if (ownerUserId === membership.user.id) {
    throw new Error('Cannot remove the workspace owner');
  }

  if (membership.role === 'admin') {
    const adminCount = await countWorkspaceAdmins(input.workspaceId);
    if (adminCount <= 1) {
      throw new Error('Cannot remove the last admin');
    }
  }

  if (membership.userId === input.actorUserId) {
    throw new Error('You cannot remove yourself. Ask another admin to remove you.');
  }

  const assignedCount = await prisma.conversation.count({
    where: { workspaceId: input.workspaceId, assignedTo: membership.userId },
  });
  if (assignedCount > 0) {
    await prisma.conversation.updateMany({
      where: { workspaceId: input.workspaceId, assignedTo: membership.userId },
      data: { assignedTo: null },
    });
  }

  await prisma.workspaceMembership.delete({ where: { id: membership.id } });
  return { success: true };
}
