import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../index.js';

export type PlatformAuditCategory =
  | 'auth'
  | 'organization'
  | 'billing'
  | 'subscription'
  | 'security'
  | 'system';

export type PlatformAuditSeverity = 'info' | 'warning' | 'danger';

export const PLATFORM_AUDIT_ACTIONS = {
  ADMIN_LOGIN: 'admin.login',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ORG_PLAN_ASSIGN: 'organization.plan.assign',
  ORG_PLAN_REMOVE: 'organization.plan.remove',
  ORG_UPDATE: 'organization.update',
  ORG_OWNER_UPDATE: 'organization.owner.update',
  ORG_IMPERSONATE: 'organization.impersonate',
  ORG_WALLET_CREDIT: 'organization.wallet.credit',
  ORG_CRM_CONTACT_PUSH: 'organization.crm_contact.push',
  COUPON_CREATE: 'coupon.create',
  COUPON_UPDATE: 'coupon.update',
  COUPON_ACTIVE: 'coupon.active',
  ORG_BILLING_OFFER_CREATE: 'organization.billing_offer.create',
  ORG_BILLING_OFFER_CANCEL: 'organization.billing_offer.cancel',
  ORG_BILLING_OFFER_DELETE: 'organization.billing_offer.delete',
} as const;

export type PlatformAuditAction =
  (typeof PLATFORM_AUDIT_ACTIONS)[keyof typeof PLATFORM_AUDIT_ACTIONS];

const ACTION_LABELS: Record<string, string> = {
  [PLATFORM_AUDIT_ACTIONS.ADMIN_LOGIN]: 'Admin Login',
  [PLATFORM_AUDIT_ACTIONS.ADMIN_LOGIN_FAILED]: 'Failed Login Attempt',
  [PLATFORM_AUDIT_ACTIONS.ORG_PLAN_ASSIGN]: 'Plan Assigned',
  [PLATFORM_AUDIT_ACTIONS.ORG_PLAN_REMOVE]: 'Plan Removed',
  [PLATFORM_AUDIT_ACTIONS.ORG_UPDATE]: 'Organization Updated',
  [PLATFORM_AUDIT_ACTIONS.ORG_OWNER_UPDATE]: 'Owner Updated',
  [PLATFORM_AUDIT_ACTIONS.ORG_IMPERSONATE]: 'Impersonation Login',
  [PLATFORM_AUDIT_ACTIONS.ORG_WALLET_CREDIT]: 'Wallet Credit Added',
  [PLATFORM_AUDIT_ACTIONS.ORG_CRM_CONTACT_PUSH]: 'Pushed to ConvoSync CRM',
  [PLATFORM_AUDIT_ACTIONS.COUPON_CREATE]: 'Coupon Created',
  [PLATFORM_AUDIT_ACTIONS.COUPON_UPDATE]: 'Coupon Updated',
  [PLATFORM_AUDIT_ACTIONS.COUPON_ACTIVE]: 'Coupon Status Changed',
  [PLATFORM_AUDIT_ACTIONS.ORG_BILLING_OFFER_CREATE]: 'Billing Offer Created',
  [PLATFORM_AUDIT_ACTIONS.ORG_BILLING_OFFER_CANCEL]: 'Billing Offer Cancelled',
  [PLATFORM_AUDIT_ACTIONS.ORG_BILLING_OFFER_DELETE]: 'Billing Offer Deleted',
};

export type AuditActor = {
  id?: string | null;
  email?: string | null;
  role?: string | null;
};

export type RecordAuditEventInput = {
  action: PlatformAuditAction | string;
  actor?: AuditActor;
  entityType?: string | null;
  entityId?: string | null;
  category?: PlatformAuditCategory;
  severity?: PlatformAuditSeverity;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
};

export function getRequestIp(request: FastifyRequest): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() ?? null;
  }
  return request.ip ?? null;
}

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve actor for PlatformAuditLog.actorId (FK → PlatformAdmin).
 * Missing/stale/wrong ids become null — email/role still recorded.
 */
async function resolveActor(actor?: AuditActor) {
  let actorId: string | null = null;
  let actorEmail = actor?.email ?? null;
  let actorRole = actor?.role ?? null;
  let unresolvedActorId: string | null = null;

  if (actor?.id) {
    const admin = await prisma.platformAdmin.findUnique({
      where: { id: actor.id },
      select: { id: true, email: true, role: true },
    });
    if (admin) {
      actorId = admin.id;
      actorEmail = actorEmail ?? admin.email;
      actorRole = actorRole ?? admin.role;
    } else {
      // ponytail: JWT/stale platformAdminId or wrong table id — null FK, keep label in metadata
      unresolvedActorId = actor.id;
    }
  }

  return {
    actorId,
    actorEmail: actorEmail ?? (unresolvedActorId ? 'unknown' : 'system'),
    actorRole: actorRole ?? (actorId ? 'Super Admin' : 'System'),
    unresolvedActorId,
  };
}

/** Fire-and-forget — never throws to callers. */
export function recordAuditEvent(input: RecordAuditEventInput): void {
  void (async () => {
    try {
      const resolved = await resolveActor(input.actor);
      const metadata: Record<string, unknown> = {
        ...(input.metadata ?? {}),
      };
      if (resolved.unresolvedActorId) {
        metadata.unresolvedActorId = resolved.unresolvedActorId;
      }
      await prisma.platformAuditLog.create({
        data: {
          actorId: resolved.actorId,
          actorEmail: resolved.actorEmail,
          actorRole: resolved.actorRole,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          category: input.category ?? 'system',
          severity: input.severity ?? 'info',
          metadata:
            Object.keys(metadata).length > 0
              ? (metadata as Prisma.InputJsonValue)
              : undefined,
          ipAddress: input.ipAddress ?? null,
        },
      });
    } catch (err) {
      console.error('[platform-audit] failed to record event:', err);
    }
  })();
}

export type PlatformAuditLogRow = {
  id: string;
  action: string;
  actor: string;
  actorRole: string;
  target?: string;
  category: PlatformAuditCategory;
  severity: PlatformAuditSeverity;
  ipAddress: string;
  time: string;
  details: string;
};

function metadataString(meta: unknown, key: string): string | undefined {
  if (meta && typeof meta === 'object' && key in meta) {
    const value = (meta as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

export function mapAuditLogRow(row: {
  id: string;
  action: string;
  actorEmail: string | null;
  actorRole: string | null;
  category: string;
  severity: string;
  ipAddress: string | null;
  metadata: unknown;
  createdAt: Date;
  entityType: string | null;
  entityId: string | null;
}): PlatformAuditLogRow {
  const meta = row.metadata;
  const target =
    metadataString(meta, 'targetLabel') ??
    metadataString(meta, 'target') ??
    (row.entityType && row.entityId ? `${row.entityType}:${row.entityId}` : undefined);

  return {
    id: row.id,
    action: auditActionLabel(row.action),
    actor: row.actorEmail ?? 'system',
    actorRole: row.actorRole ?? 'System',
    target,
    category: row.category as PlatformAuditCategory,
    severity: row.severity as PlatformAuditSeverity,
    ipAddress: row.ipAddress ?? '—',
    time: row.createdAt.toISOString(),
    details: metadataString(meta, 'details') ?? auditActionLabel(row.action),
  };
}

export async function listPlatformAuditLogs(query: {
  page: number;
  pageSize: number;
  category?: PlatformAuditCategory;
  severity?: PlatformAuditSeverity;
  action?: string;
  search?: string;
  from?: Date;
  to?: Date;
}) {
  const where: Prisma.PlatformAuditLogWhereInput = {};

  if (query.category) where.category = query.category;
  if (query.severity) where.severity = query.severity;
  if (query.action) where.action = query.action;

  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }

  const search = query.search?.trim();
  if (search) {
    where.OR = [
      { action: { contains: search, mode: 'insensitive' } },
      { actorEmail: { contains: search, mode: 'insensitive' } },
      { entityType: { contains: search, mode: 'insensitive' } },
      { entityId: { contains: search, mode: 'insensitive' } },
      { actorRole: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.platformAuditLog.count({ where }),
    prisma.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    logs: rows.map(mapAuditLogRow),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
  };
}
