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
> & { planId?: string | null; isSuperAdmin?: boolean };

/** Workspace row fields every paid activation path must write (closes trial). */
export function paidActivationWorkspaceFields() {
  return {
    subscriptionStatus: 'active' as const,
    trialEndsAt: null,
  };
}

/** Active/authenticated paid status, or a plan already attached over stale trial status. */
export function hasPaidPlanPriority(
  workspace: Pick<WorkspaceTrialFields, 'subscriptionStatus' | 'planId'>
) {
  const status = workspace.subscriptionStatus;
  if (status === 'active' || status === 'authenticated') return true;
  // planId set while status still 'trial' = activation wrote plan but left trial status
  return Boolean(workspace.planId) && status === 'trial';
}

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

/** Fields every new customer workspace should get (not super-admin). */
export function newCustomerTrialFields(startedAt = new Date(), trialDays = DEFAULT_TRIAL_DAYS) {
  const { trialStartedAt, trialEndsAt } = buildTrialWindow(startedAt, trialDays);
  return {
    planId: null as string | null,
    subscriptionStatus: 'trial' as const,
    trialStartedAt,
    trialEndsAt,
  };
}

export function isTrialExpired(workspace: WorkspaceTrialFields, now = new Date()) {
  if (hasPaidPlanPriority(workspace)) return false;
  if (workspace.subscriptionStatus !== 'trial') return false;
  if (!workspace.trialEndsAt) return false;
  return workspace.trialEndsAt.getTime() <= now.getTime();
}

export function trialDaysLeft(workspace: WorkspaceTrialFields, now = new Date()) {
  if (hasPaidPlanPriority(workspace)) return 0;
  if (workspace.subscriptionStatus !== 'trial' || !workspace.trialEndsAt) return 0;
  const ms = workspace.trialEndsAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

export function subscriptionDisplayStatus(
  workspace: WorkspaceTrialFields,
  now = new Date()
): SubscriptionDisplayStatus {
  // Paid plan always wins over leftover trialEndsAt / stale trial status
  if (hasPaidPlanPriority(workspace)) return 'Active';

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
  if (hasPaidPlanPriority(workspace)) return false;
  return workspace.subscriptionStatus === 'trial' && !isTrialExpired(workspace, now);
}

export function canWriteWithSubscription(status: string, workspace: WorkspaceTrialFields, now = new Date()) {
  if (workspace.isSuperAdmin) return true;
  if (status === 'active' || status === 'authenticated') return true;
  if (hasPaidPlanPriority(workspace)) return true;
  if (status === 'trial') return !isTrialExpired(workspace, now);
  return false;
}

export function serializeTrialInfo(
  workspace: WorkspaceTrialFields & { plan?: Pick<SubscriptionPlan, 'name' | 'slug'> | null },
  now = new Date()
) {
  const displayStatus = subscriptionDisplayStatus(workspace, now);
  const daysLeft = trialDaysLeft(workspace, now);
  const onTrial = displayStatus === 'Trial';

  return {
    subscriptionStatus: hasPaidPlanPriority(workspace) ? 'active' : workspace.subscriptionStatus,
    displayStatus,
    isTrial: onTrial,
    trialStartedAt: workspace.trialStartedAt?.toISOString() ?? null,
    // Don't surface a future trial end once paid — UI must not prefer trialEndsAt over paid
    trialEndsAt:
      hasPaidPlanPriority(workspace) || !onTrial
        ? null
        : (workspace.trialEndsAt?.toISOString() ?? null),
    trialDaysLeft: daysLeft,
    trialExpired:
      !hasPaidPlanPriority(workspace) &&
      workspace.subscriptionStatus === 'trial' &&
      isTrialExpired(workspace, now),
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
      planId: true,
    },
  });

  if (!workspace || workspace.subscriptionStatus !== 'trial') {
    return workspace?.subscriptionStatus ?? null;
  }

  // Paid plan attached — never flip to past_due from trial expiry
  if (hasPaidPlanPriority(workspace)) {
    return workspace.subscriptionStatus;
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
      planId: null,
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
    data: paidActivationWorkspaceFields(),
  });
}

export async function backfillWorkspaceTrials(defaultDays = DEFAULT_TRIAL_DAYS) {
  // Never re-trial workspaces that already paid (trialEndsAt is cleared on activation)
  const workspaces = await prisma.workspace.findMany({
    where: {
      planId: null,
      subscriptionStatus: { notIn: ['active', 'authenticated', 'suspended'] },
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
