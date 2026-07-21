import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { prisma } from '../../lib/prisma.js';

const STATUS = z.enum(['new', 'contacted', 'closed']);

export default async function platformDemoRequestRoutes(fastify: FastifyInstance) {
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
      prisma.demoRequest.count({ where }),
      prisma.demoRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));

    return {
      items: items.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        message: row.message,
        status: row.status,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages,
      },
    };
  });

  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ status: STATUS }).parse(request.body ?? {});

    const existing = await prisma.demoRequest.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Demo request not found' });

    const updated = await prisma.demoRequest.update({
      where: { id },
      data: { status: body.status },
    });

    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      message: updated.message,
      status: updated.status,
      source: updated.source,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}
