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
  subject: z
    .string()
    .trim()
    .max(160)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  message: z.string().trim().min(1).max(2000),
  source: z.string().trim().max(40).optional().default('landing'),
});

export default async function supportRequestRoutes(fastify: FastifyInstance) {
  fastify.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body ?? {});

    const row = await prisma.supportRequest.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        phone: body.phone,
        subject: body.subject,
        message: body.message,
        source: body.source || 'landing',
        status: 'new',
      },
      select: { id: true, createdAt: true },
    });

    return reply.code(201).send({ ok: true, id: row.id });
  });
}
