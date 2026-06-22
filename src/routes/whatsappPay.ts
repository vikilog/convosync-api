import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { companyAuth } from '../middleware/workspaceScope.js';
import { getJwtUser } from '../middleware/auth.js';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import { WhatsAppPayService } from '../services/whatsappPay.service.js';

const createRequestSchema = z.object({
  contactId: z.string().optional(),
  contactName: z.string().min(1),
  contactPhone: z.string().min(5),
  amountPaise: z.number().int().positive(),
  description: z.string().min(1).max(500),
  sendMode: z.enum(['plain', 'template']).optional(),
  templateId: z.string().optional(),
  templateVariables: z.array(z.string()).optional(),
});

export default async function whatsappPayRoutes(fastify: FastifyInstance) {
  const razorpayService = new RazorpayService(fastify);
  const service = new WhatsAppPayService(razorpayService);

  fastify.get('/summary', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
    const summary = await service.getSummary(user.workspaceId);
    return reply.send(summary);
  });

  fastify.get('/requests', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
    const { status } = request.query as { status?: string };
    const result = await service.listRequests(user.workspaceId, status);
    return reply.send(result);
  });

  fastify.post('/requests', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = createRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }

    try {
      const result = await service.createRequest(user.workspaceId, {
        ...parsed.data,
      });
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to create payment request',
      });
    }
  });

  fastify.post('/requests/:id/send', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = request.params as { id: string };

    try {
      const result = await service.sendRequest(user.workspaceId, id);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to send payment request',
      });
    }
  });

  fastify.post(
    '/requests/:id/cancel',
    { onRequest: companyAuth.onRequest },
    async (request, reply) => {
      const user = getJwtUser(request);
      if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
      const { id } = request.params as { id: string };

      try {
        const result = await service.cancelRequest(user.workspaceId, id);
        return reply.send(result);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Failed to cancel payment request',
        });
      }
    }
  );

  fastify.post(
    '/requests/:id/refresh',
    { onRequest: companyAuth.onRequest },
    async (request, reply) => {
      const user = getJwtUser(request);
      if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
      const { id } = request.params as { id: string };

      try {
        const result = await service.refreshRequest(user.workspaceId, id);
        return reply.send(result);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Failed to refresh payment request',
        });
      }
    }
  );
}
