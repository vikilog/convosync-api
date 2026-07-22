import type { SubscriptionPlan, Workspace } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export const DEFAULT_TRIAL_DAYS = 14;

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';

export type SubscriptionDisplayStatus =
  | 'Trial'
  | 'Active'
  | 'Past Due'
  | 'Suspended'
  | 'Cancelled';

type WorkspaceTrialFields = Pick<
  Workspace,
  'subscriptionStatus' | 'trialStartedAt' | 'trialEndsAt'
> & { isSuperAdmin?: boolean };

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveTrialDays(plan?: Pick<SubscriptionPlan, 'trialDays'> | null) {
  if (!plan || plan.trialDays <= 0) return DEFAULT_TRIAL_DAYS;
  return plan.trialDays;
}

export function buildTrialWindow(
  startedAt: Date,
  trialDays: number
): { trialStartedAt: Date; trialEndsAt: Date } {
  return {
    trialStartedAt: startedAt,
    trialEndsAt: addDays(startedAt, trialDays),
  };
}

export function isTrialExpired(workspace: WorkspaceTrialFields, now = new Date()) {
  if (workspace.subscriptionStatus !== 'trial') return false;
  if (!workspace.trialEndsAt) return false;
  return workspace.trialEndsAt.getTime() <= now.getTime();
}

export function trialDaysLeft(workspace: WorkspaceTrialFields, now = new Date()) {
  if (workspace.subscriptionStatus !== 'trial' || !workspace.trialEndsAt) return 0;
  const ms = workspace.trialEndsAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export function subscriptionDisplayStatus(
  workspace: WorkspaceTrialFields,
  now = new Date()
): SubscriptionDisplayStatus {
  if (workspace.subscriptionStatus === 'trial') {
    return isTrialExpired(workspace, now) ? 'Past Due' : 'Trial';
  }

  const map: Record<string, SubscriptionDisplayStatus> = {
    active: 'Active',
    past_due: 'Past Due',
    suspended: 'Suspended',
    cancelled: 'Cancelled',
  };

  return map[workspace.subscriptionStatus] ?? 'Trial';
}

export function isTrialActive(workspace: WorkspaceTrialFields, now = new Date()) {
  return workspace.subscriptionStatus === 'trial' && !isTrialExpired(workspace, now);
}

export function canWriteWithSubscription(status: string, workspace: WorkspaceTrialFields, now = new Date()) {
  if (workspace.isSuperAdmin) return true;
  if (status === 'active') return true;
  if (status === 'trial') return !isTrialExpired(workspace, now);
  return false;
}

export function serializeTrialInfo(
  workspace: WorkspaceTrialFields & { plan?: Pick<SubscriptionPlan, 'name' | 'slug'> | null },
  now = new Date()
) {
  const displayStatus = subscriptionDisplayStatus(workspace, now);
  const daysLeft = trialDaysLeft(workspace, now);

  return {
    subscriptionStatus: workspace.subscriptionStatus,
    displayStatus,
    isTrial: displayStatus === 'Trial',
    trialStartedAt: workspace.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: workspace.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: daysLeft,
    trialExpired: workspace.subscriptionStatus === 'trial' && isTrialExpired(workspace, now),
    planSlug: workspace.plan?.slug ?? null,
    planName: workspace.plan?.name ?? null,
  };
}

export async function expireTrialIfNeeded(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      subscriptionStatus: true,
      trialStartedAt: true,
      trialEndsAt: true,
    },
  });

  if (!workspace || workspace.subscriptionStatus !== 'trial') {
    return workspace?.subscriptionStatus ?? null;
  }

  if (!isTrialExpired(workspace)) {
    return workspace.subscriptionStatus;
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { subscriptionStatus: 'past_due' },
  });

  return 'past_due' as const;
}

export async function expireDueTrials() {
  const now = new Date();
  const result = await prisma.workspace.updateMany({
    where: {
      subscriptionStatus: 'trial',
      trialEndsAt: { lte: now },
    },
    data: { subscriptionStatus: 'past_due' },
  });
  return result.count;
}

export type ExtendWorkspaceTrialInput = {
  extraDays: number;
  reason: string;
  platformAdminId?: string;
};

export async function extendWorkspaceTrial(
  workspaceId: string,
  { extraDays, reason, platformAdminId }: ExtendWorkspaceTrialInput
) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');

  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3) {
    throw new Error('A reason of at least 3 characters is required');
  }

  const baseEnd =
    workspace.trialEndsAt && workspace.trialEndsAt > new Date()
      ? workspace.trialEndsAt
      : new Date();

  const trialStartedAt = workspace.trialStartedAt ?? workspace.createdAt;
  const newEndsAt = addDays(baseEnd, extraDays);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.workspace.update({
      where: { id: workspaceId },
      data: {
        subscriptionStatus: 'trial',
        trialStartedAt,
        trialEndsAt: newEndsAt,
      },
    });

    await tx.trialExtensionLog.create({
      data: {
        workspaceId,
        platformAdminId: platformAdminId ?? null,
        daysAdded: extraDays,
        reason: trimmedReason,
        previousEndsAt: workspace.trialEndsAt,
        newEndsAt,
      },
    });

    return updated;
  });
}

export async function activateWorkspaceSubscription(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error('Workspace not found');

  return prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      subscriptionStatus: 'active',
      trialEndsAt: workspace.trialEndsAt ?? new Date(),
    },
  });
}

export async function backfillWorkspaceTrials(defaultDays = DEFAULT_TRIAL_DAYS) {
  const workspaces = await prisma.workspace.findMany({
    where: {
      OR: [{ trialStartedAt: null }, { trialEndsAt: null }],
    },
    select: { id: true, createdAt: true, plan: { select: { trialDays: true } } },
  });

  for (const workspace of workspaces) {
    const days = resolveTrialDays(workspace.plan);
    const { trialStartedAt, trialEndsAt } = buildTrialWindow(workspace.createdAt, days || defaultDays);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        trialStartedAt,
        trialEndsAt,
        subscriptionStatus: 'trial',
      },
    });
  }

  return workspaces.length;
}
