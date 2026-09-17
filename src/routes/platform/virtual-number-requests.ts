import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { emitNotification } from '../../services/notifications/emitNotification.js';
import { NOTIFICATION_TYPES } from '../../services/notifications/types.js';
import { allocateNumberForPaidRequest } from '../virtualNumber.js';

const STATUS = z.enum([
  'pending_approval',
  'approved',
  'rejected',
  'number_selected',
  'paid',
  'active',
]);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: STATUS.optional(),
});

const idParamsSchema = z.object({ id: z.string() });
const rejectBodySchema = z.object({ reason: z.string().trim().min(1).max(500) });

function serialize(row: {
  id: string;
  workspaceId: string;
  status: string;
  requestedAt: Date;
  requestedByUserId: string | null;
  approvedAt: Date | null;
  approvedByPlatformAdminId: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  selectedNumber: string | null;
  selectedCity: string | null;
  selectedPriceInrPaise: number | null;
  paidAt: Date | null;
  plivoNumberId: string | null;
  activatedAt: Date | null;
  purchaseError: string | null;
  createdAt: Date;
  workspace?: { name: string; email: string | null; slug: string } | null;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspace?.name ?? null,
    workspaceEmail: row.workspace?.email ?? null,
    workspaceSlug: row.workspace?.slug ?? null,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    selectedNumber: row.selectedNumber,
    selectedCity: row.selectedCity,
    selectedPriceInrPaise: row.selectedPriceInrPaise,
    paidAt: row.paidAt?.toISOString() ?? null,
    plivoNumberId: row.plivoNumberId,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    purchaseError: row.purchaseError,
    createdAt: row.createdAt.toISOString(),
  };
}

export default async function platformVirtualNumberRequestRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', { schema: { querystring: listQuerySchema } }, async (request) => {
    const query = request.query;

    const where = query.status ? { status: query.status } : {};
    const [total, items] = await Promise.all([
      prisma.virtualNumberRequest.count({ where }),
      prisma.virtualNumberRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { workspace: { select: { name: true, email: true, slug: true } } },
      }),
    ]);

    return {
      items: items.map(serialize),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  });

  app.get('/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;
    const row = await prisma.virtualNumberRequest.findUnique({
      where: { id },
      include: { workspace: { select: { name: true, email: true, slug: true } } },
    });
    if (!row) return reply.code(404).send({ error: 'Request not found' });
    return { item: serialize(row) };
  });

  app.post('/:id/approve', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;
    const admin = getJwtUser(request);

    const existing = await prisma.virtualNumberRequest.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Request not found' });
    if (existing.status !== 'pending_approval') {
      return reply.code(409).send({ error: `Cannot approve a request in "${existing.status}" state.` });
    }

    const updated = await prisma.virtualNumberRequest.update({
      where: { id },
      data: {
        status: 'approved',
        approvedAt: new Date(),
        approvedByPlatformAdminId: admin.platformAdminId ?? null,
      },
    });

    void emitNotification({
      workspaceId: updated.workspaceId,
      type: NOTIFICATION_TYPES.VIRTUAL_NUMBER_APPROVED,
      title: 'Virtual number request approved',
      message: 'Your virtual number request has been approved — pick a number and activate it in Integrations.',
      entityType: 'virtual_number_request',
      entityId: updated.id,
      targetUserId: updated.requestedByUserId,
    });

    return serialize(updated);
  });

  app.post(
    '/:id/reject',
    { schema: { params: idParamsSchema, body: rejectBodySchema } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;

    const existing = await prisma.virtualNumberRequest.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Request not found' });
    if (existing.status !== 'pending_approval') {
      return reply.code(409).send({ error: `Cannot reject a request in "${existing.status}" state.` });
    }

    const updated = await prisma.virtualNumberRequest.update({
      where: { id },
      data: { status: 'rejected', rejectedAt: new Date(), rejectionReason: body.reason },
    });
    return serialize(updated);
  });

  /** The manual gate: a workspace's payment only reaches `paid` — the actual carrier
   * number isn't bought until an admin allocates one here. See allocateNumberForPaidRequest()
   * in ../virtualNumber.ts for what this triggers. */
  app.post('/:id/allocate-number', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;

    const existing = await prisma.virtualNumberRequest.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Request not found' });
    if (existing.status !== 'paid') {
      return reply.code(409).send({ error: `Cannot allocate a number for a request in "${existing.status}" state.` });
    }

    try {
      const active = await allocateNumberForPaidRequest(existing);

      void emitNotification({
        workspaceId: active.workspaceId,
        type: NOTIFICATION_TYPES.VIRTUAL_NUMBER_ACTIVATED,
        title: 'Your virtual number is live',
        message: 'Your virtual number has been activated and is ready to use in Calls and Journeys.',
        entityType: 'virtual_number_request',
        entityId: active.id,
        targetUserId: active.requestedByUserId,
      });

      return serialize(active);
    } catch (err) {
      const failed = await prisma.virtualNumberRequest.update({
        where: { id: existing.id },
        data: { purchaseError: err instanceof Error ? err.message : 'Number purchase failed' },
      });
      return reply.code(502).send({ ...serialize(failed), error: failed.purchaseError });
    }
  });
}
