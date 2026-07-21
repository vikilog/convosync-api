import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  phone: z
    .string()
    .trim()
    .max(40)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  message: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  source: z.string().trim().max(40).optional().default('landing'),
});

export default async function demoRequestRoutes(fastify: FastifyInstance) {
  fastify.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body ?? {});

    const row = await prisma.demoRequest.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        phone: body.phone,
        message: body.message,
        source: body.source || 'landing',
        status: 'new',
      },
      select: { id: true, createdAt: true },
    });

    return reply.code(201).send({ ok: true, id: row.id });
  });
}
