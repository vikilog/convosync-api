import type { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { config } from '../config.js';
import {
  getWorkspaceOwnerUserId,
  resolveMembershipAccess,
} from './workspaceMemberAdmin.js';
import { onboardingPayloadFromUser } from './onboarding.js';
import { activateWorkspaceSubscription } from './trial.js';

export async function suspendWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');
  if (workspace.subscriptionStatus === 'suspended') {
    throw new Error('Workspace is already suspended');
  }

  return prisma.workspace.update({
    where: { id: workspaceId },
    data: { subscriptionStatus: 'suspended' },
  });
}

export async function reactivateWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');
  if (workspace.subscriptionStatus !== 'suspended') {
    throw new Error('Workspace is not suspended');
  }
  return activateWorkspaceSubscription(workspaceId);
}

export async function updateWorkspaceLimits(
  workspaceId: string,
  limits: {
    contactsLimit?: number;
    teamMembersLimit?: number;
    aiAgentsLimit?: number;
    channelsLimit?: number;
    aiTokensIncluded?: number;
    campaignsLimit?: number;
    emailsLimit?: number;
  }
) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');

  const data = Object.fromEntries(
    Object.entries(limits).filter(([, value]) => value !== undefined)
  );
  if (Object.keys(data).length === 0) {
    throw new Error('At least one limit must be provided');
  }

  return prisma.workspaceUsageLimits.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  });
}

export async function setWorkspaceAgentEnabled(
  workspaceId: string,
  agentId: string,
  isEnabled: boolean
) {
  const agent = await prisma.aiAgent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true, name: true, isEnabled: true },
  });
  if (!agent) throw new Error('AI agent not found in this workspace');

  const updated = await prisma.aiAgent.update({
    where: { id: agentId },
    data: { isEnabled },
    select: { id: true, name: true, isEnabled: true, isPublished: true },
  });

  return updated;
}

export async function getWorkspaceAuditTrail(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, subscriptionStatus: true, createdAt: true, updatedAt: true },
  });
  if (!workspace) throw new Error('Workspace not found');

  const trialLogs = await prisma.trialExtensionLog.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { platformAdmin: { select: { name: true, email: true } } },
  });

  const events = trialLogs.map((log) => ({
    id: log.id,
    type: 'trial_extended' as const,
    title: `Trial extended by ${log.daysAdded} day${log.daysAdded === 1 ? '' : 's'}`,
    detail: log.reason,
    actor: log.platformAdmin?.name ?? 'Platform admin',
    actorEmail: log.platformAdmin?.email ?? null,
    at: log.createdAt.toISOString(),
  }));

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      subscriptionStatus: workspace.subscriptionStatus,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    },
    events,
  };
}

export async function createWorkspaceImpersonationSession(
  fastify: FastifyInstance,
  workspaceId: string,
  platformAdminId: string
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true },
  });
  if (!workspace) throw new Error('Workspace not found');

  const ownerUserId = await getWorkspaceOwnerUserId(workspaceId);
  if (!ownerUserId) throw new Error('No workspace owner found');

  const user = await prisma.user.findUnique({ where: { id: ownerUserId } });
  if (!user) throw new Error('Owner user not found');

  const access = await resolveMembershipAccess(user.id, workspaceId);
  const token = fastify.jwt.sign(
    {
      userId: user.id,
      workspaceId,
      role: access.role,
      impersonatedBy: platformAdminId,
    },
    { expiresIn: '2h' }
  );

  return {
    token,
    appUrl: config.frontendUrl,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      role: access.role,
      permissions: access.permissions,
      inboxScope: access.inboxScope,
      ...onboardingPayloadFromUser(user),
    },
    workspace: { id: workspace.id, name: workspace.name },
    activeWorkspaceId: workspaceId,
  };
}
