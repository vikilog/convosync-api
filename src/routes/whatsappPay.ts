import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { planFeatureAuth } from '../middleware/planFeatureAuth.js';
import { getJwtUser } from '../middleware/auth.js';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import { WhatsAppPayService } from '../services/whatsappPay.service.js';
import { createRequestSchema } from './whatsappPay.schemas.js';

export default async function whatsappPayRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const razorpayService = new RazorpayService(fastify);
  const service = new WhatsAppPayService(razorpayService);
  const auth = planFeatureAuth('whatsappPay');

  app.get('/summary', auth, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
    const summary = await service.getSummary(user.workspaceId);
    return reply.send(summary);
  });

  app.get('/requests', auth, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });
    const { status } = request.query as { status?: string };
    const result = await service.listRequests(user.workspaceId, status);
    return reply.send(result);
  });

  app.post(
    '/requests',
    { ...auth, schema: { body: createRequestSchema } },
    async (request, reply) => {
      const user = getJwtUser(request);
      if (!user?.workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      try {
        const result = await service.createRequest(user.workspaceId, {
          ...request.body,
        });
        return reply.code(201).send(result);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Failed to create payment request',
        });
      }
    }
  );

  app.post('/requests/:id/send', auth, async (request, reply) => {
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

  app.post('/requests/:id/cancel', auth, async (request, reply) => {
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
  });

  app.post('/requests/:id/refresh', auth, async (request, reply) => {
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
  });
}
