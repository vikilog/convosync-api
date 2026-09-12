import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { AiKnowledgeController } from '../controllers/ai-knowledge.controller.js';
import { initAiKnowledgeModule } from '../container.js';
import {
  aiContextQuerySchema,
  listCollectionsSchema,
  saveAiKnowledgeConfigSchema,
  syncAiKnowledgeSchema,
  syncCollectionSchema,
} from '../ai-knowledge.schemas.js';

export default async function aiKnowledgeRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const container = initAiKnowledgeModule(prisma);
  const controller = new AiKnowledgeController(container);
  const auth = companyAuth;

  app.get('/config', auth, controller.getConfig);
  app.put('/config', { ...auth, schema: { body: saveAiKnowledgeConfigSchema } }, controller.saveConfig);
  app.post(
    '/collections',
    { ...auth, schema: { body: listCollectionsSchema } },
    controller.listCollections
  );
  app.post(
    '/sync/collection',
    { ...auth, schema: { body: syncCollectionSchema } },
    controller.syncCollection
  );
  app.post('/sync', { ...auth, schema: { body: syncAiKnowledgeSchema } }, controller.sync);
  app.post(
    '/context',
    { ...auth, schema: { body: aiContextQuerySchema } },
    controller.getContextForQuery
  );
  app.get('/:venueId', auth, controller.getByVenue);
}
