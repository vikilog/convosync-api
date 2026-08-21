import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { prisma } from '../../lib/prisma.js';

const STATUS = z.enum(['new', 'contacted', 'closed']);

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
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/', async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        status: STATUS.optional(),
      })
      .parse(request.query);

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

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.supportRequest.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'Support request not found' });
    return { item: serialize(row) };
  });

  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ status: STATUS }).parse(request.body ?? {});

    const existing = await prisma.supportRequest.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Support request not found' });

    const updated = await prisma.supportRequest.update({
      where: { id },
      data: { status: body.status },
    });

    return serialize(updated);
  });
}
