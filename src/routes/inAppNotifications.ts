import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { severityForType } from '../services/notifications/types.js';
import {
  activityWhereForRole,
  normalizeActivityRole,
} from '../services/notifications/activityScope.js';
import { resolveMembershipRole } from '../services/workspaceMemberAdmin.js';

function serializeNotification(
  row: {
    id: string;
    workspaceId: string;
    type: string;
    category: string;
    title: string;
    message: string;
    entityType: string | null;
    entityId: string | null;
    actorUserId: string | null;
    targetUserId: string | null;
    metadata: unknown;
    createdAt: Date;
    reads?: { id: string }[];
  },
  unread: boolean
) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    category: row.category,
    title: row.title,
    message: row.message,
    entityType: row.entityType,
    entityId: row.entityId,
    actorUserId: row.actorUserId,
    targetUserId: row.targetUserId,
    metadata: row.metadata,
    severity: severityForType(row.type),
    createdAt: row.createdAt.toISOString(),
    unread,
  };
}

export default async function inAppNotificationRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId, userId } = getJwtUser(request);
    const q = z
      .object({
        category: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      })
      .parse(request.query);

    const limit = q.limit ?? 40;
    const where = {
      workspaceId,
      ...(q.category && q.category !== 'all' ? { category: q.category } : {}),
    };

    const rows = await prisma.workspaceNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(q.cursor
        ? { skip: 1, cursor: { id: q.cursor } }
        : {}),
      include: {
        reads: { where: { userId }, select: { id: true }, take: 1 },
      },
    });

    return {
      items: rows.map((row) => serializeNotification(row, row.reads.length === 0)),
    };
  });

  fastify.get('/unread-count', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId, userId } = getJwtUser(request);
    const total = await prisma.workspaceNotification.count({ where: { workspaceId } });
    const read = await prisma.notificationRead.count({
      where: { userId, notification: { workspaceId } },
    });
    return { unread: Math.max(0, total - read) };
  });

  /** Role-scoped running log for dashboard Recent Activity. */
  fastify.get('/activity', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId, userId } = getJwtUser(request);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(request.query);

    const role = normalizeActivityRole(await resolveMembershipRole(userId, workspaceId));
    const where = activityWhereForRole({ workspaceId, userId, role });

    const rows = await prisma.workspaceNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 20,
    });

    return {
      role,
      items: rows.map((row) => serializeNotification(row, true)),
    };
  });

  fastify.post('/:id/read', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const { id } = request.params as { id: string };

    const note = await prisma.workspaceNotification.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!note) return reply.code(404).send({ error: 'Notification not found' });

    await prisma.notificationRead.upsert({
      where: { notificationId_userId: { notificationId: id, userId } },
      create: { notificationId: id, userId },
      update: { readAt: new Date() },
    });

    return { ok: true };
  });

  fastify.post('/read-all', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId, userId } = getJwtUser(request);

    const unread = await prisma.workspaceNotification.findMany({
      where: {
        workspaceId,
        reads: { none: { userId } },
      },
      select: { id: true },
      take: 500,
    });

    if (unread.length > 0) {
      await prisma.notificationRead.createMany({
        data: unread.map((n) => ({ notificationId: n.id, userId })),
        skipDuplicates: true,
      });
    }

    return { ok: true, marked: unread.length };
  });
}
