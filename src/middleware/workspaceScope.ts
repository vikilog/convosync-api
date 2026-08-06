import { FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, getJwtUser } from './auth.js';
import { prisma } from '../lib/prisma.js';
import { endPhase, enterRequestTiming, startPhase } from '../lib/request-timing.js';
import { canWriteWithSubscription } from '../services/trial.js';
import { userHasWorkspaceAccess } from '../services/workspaceMembership.js';

/** JWT auth + verify user belongs to active company (workspace) in token. */
export async function requireWorkspaceAccess(request: FastifyRequest, reply: FastifyReply) {
  if (reply.sent) return;
  if (request.__perfStore) enterRequestTiming(request.__perfStore);
  startPhase('auth');
  try {
    const user = getJwtUser(request);
    if (!user?.userId || !user?.workspaceId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const allowed = await userHasWorkspaceAccess(user.userId, user.workspaceId);
    if (!allowed) {
      return reply.code(403).send({ error: 'No access to this company workspace' });
    }
  } finally {
    endPhase('auth');
  }
}

/** Block mutating API calls when subscription is past_due or suspended. */
export async function requireWritableSubscription(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (reply.sent) return;
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;

  if (request.__perfStore) enterRequestTiming(request.__perfStore);
  startPhase('auth');
  try {
    const user = getJwtUser(request);
    if (!user?.workspaceId) return;

    const workspace = await prisma.workspace.findUnique({
      where: { id: user.workspaceId },
      select: {
        isSuperAdmin: true,
        subscriptionStatus: true,
        trialStartedAt: true,
        trialEndsAt: true,
        planId: true,
      },
    });

    if (!workspace) {
      return reply.code(404).send({ error: 'Company workspace not found' });
    }

    if (!canWriteWithSubscription(workspace.subscriptionStatus, workspace)) {
      return reply.code(402).send({
        error: 'Subscription inactive. Upgrade to continue.',
        code: 'subscription_inactive',
        subscriptionStatus: workspace.subscriptionStatus,
      });
    }
  } finally {
    endPhase('auth');
  }
}

export const companyAuth = {
  onRequest: [authenticate, requireWorkspaceAccess, requireWritableSubscription],
};

/** Billing routes: allow past_due workspaces to pay without requireWritableSubscription. */
export const companyAuthBilling = {
  onRequest: [authenticate, requireWorkspaceAccess],
};

const FORBIDDEN_WRITE_FIELDS = new Set([
  'workspaceId',
  'id',
  'createdAt',
  'updatedAt',
  'slug',
  'waNumberId',
  'waToken',
  'wabaId',
  'waPhoneNumber',
]);

/** Prevent clients from overriding company scope via request body. */
export function scopedUpdateData<T extends Record<string, unknown>>(data: T): Partial<T> {
  const out = { ...data };
  for (const key of FORBIDDEN_WRITE_FIELDS) {
    delete out[key];
  }
  return out;
}

export function companyScopedData<T extends Record<string, unknown>>(
  workspaceId: string,
  data: T
): T & { workspaceId: string } {
  const clean = scopedUpdateData(data) as T;
  return { ...clean, workspaceId };
}
