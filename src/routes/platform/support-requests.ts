import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { prisma } from '../../lib/prisma.js';

const STATUS = z.enum(['new', 'contacted', 'closed']);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: STATUS.optional(),
});

const idParamsSchema = z.object({ id: z.string() });
const statusBodySchema = z.object({ status: STATUS });

function serialize(row: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  subject: string | null;
  message: string;
  status: string;
  source: string;
  workspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    subject: row.subject,
    message: row.message,
    status: row.status,
    source: row.source,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function platformSupportRequestRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', { schema: { querystring: listQuerySchema } }, async (request) => {
    const query = request.query;

    const where = query.status ? { status: query.status } : {};
    const [total, items] = await Promise.all([
      prisma.supportRequest.count({ where }),
      prisma.supportRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));

    return {
      items: items.map(serialize),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages,
      },
    };
  });

  app.get('/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;
    const row = await prisma.supportRequest.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'Support request not found' });
    return { item: serialize(row) };
  });

  app.patch(
    '/:id',
    { schema: { params: idParamsSchema, body: statusBodySchema } },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;

    const existing = await prisma.supportRequest.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Support request not found' });

    const updated = await prisma.supportRequest.update({
      where: { id },
      data: { status: body.status },
    });

    return serialize(updated);
  });
}
