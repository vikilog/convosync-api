import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../lib/prisma.js';
import { demoRequestCreateSchema } from './demo-requests.schemas.js';

export default async function demoRequestRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/', { schema: { body: demoRequestCreateSchema } }, async (request, reply) => {
    const body = request.body;

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
