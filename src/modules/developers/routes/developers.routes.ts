import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../../../index.js';
import { planFeatureAuth } from '../../../middleware/planFeatureAuth.js';
import { DevelopersController, IncomingWebhookController } from '../controllers/developers.controller.js';
import { initDevelopersModule } from '../container.js';
import {
  createOutgoingWebhookSchema,
  updateIncomingWebhookSchema,
  updateOutgoingWebhookSchema,
  upsertActionSchema,
  webhookLogsQuerySchema,
} from '../developers.schemas.js';

export default async function developersRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const container = initDevelopersModule(prisma);
  const controller = new DevelopersController(container);
  const incoming = new IncomingWebhookController(container);
  const auth = planFeatureAuth('developers');

  // Public incoming webhook endpoint (secret via header)
  app.post('/incoming/:slug', incoming.receive);

  // Authenticated developer console APIs
  app.get('/webhooks/incoming', auth, controller.getIncomingWebhook);
  app.put(
    '/webhooks/incoming',
    { ...auth, schema: { body: updateIncomingWebhookSchema } },
    controller.updateIncomingWebhook
  );
  app.get('/webhooks/outgoing', auth, controller.listOutgoingWebhooks);
  app.post(
    '/webhooks/outgoing',
    { ...auth, schema: { body: createOutgoingWebhookSchema } },
    controller.createOutgoingWebhook
  );
  app.put(
    '/webhooks/outgoing/:id',
    { ...auth, schema: { body: updateOutgoingWebhookSchema } },
    controller.updateOutgoingWebhook
  );
  app.delete('/webhooks/outgoing/:id', auth, controller.deleteOutgoingWebhook);
  app.get(
    '/webhooks/logs',
    { ...auth, schema: { querystring: webhookLogsQuerySchema } },
    controller.listWebhookLogs
  );

  app.get('/actions', auth, controller.listActions);
  app.put('/actions', { ...auth, schema: { body: upsertActionSchema } }, controller.upsertAction);

  app.get('/ai-sync', auth, controller.getAiSyncDashboard);
  app.get('/ai-sync/events', auth, controller.listAiSyncEvents);
  app.post('/ai-sync/rebuild', auth, controller.rebuildKnowledge);
}
