import type { FastifyInstance } from 'fastify';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { DevelopersController, IncomingWebhookController } from '../controllers/developers.controller.js';
import { initDevelopersModule } from '../container.js';

export default async function developersRoutes(fastify: FastifyInstance) {
  const container = initDevelopersModule(prisma);
  const controller = new DevelopersController(container);
  const incoming = new IncomingWebhookController(container);
  const auth = companyAuth;

  // Public incoming webhook endpoint (secret via header)
  fastify.post('/incoming/:slug', incoming.receive);

  // Authenticated developer console APIs
  fastify.get('/webhooks/incoming', auth, controller.getIncomingWebhook);
  fastify.put('/webhooks/incoming', auth, controller.updateIncomingWebhook);
  fastify.get('/webhooks/outgoing', auth, controller.listOutgoingWebhooks);
  fastify.post('/webhooks/outgoing', auth, controller.createOutgoingWebhook);
  fastify.put('/webhooks/outgoing/:id', auth, controller.updateOutgoingWebhook);
  fastify.delete('/webhooks/outgoing/:id', auth, controller.deleteOutgoingWebhook);
  fastify.get('/webhooks/logs', auth, controller.listWebhookLogs);

  fastify.get('/actions', auth, controller.listActions);
  fastify.put('/actions', auth, controller.upsertAction);

  fastify.get('/ai-sync', auth, controller.getAiSyncDashboard);
  fastify.get('/ai-sync/events', auth, controller.listAiSyncEvents);
  fastify.post('/ai-sync/rebuild', auth, controller.rebuildKnowledge);
}
