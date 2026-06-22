import type { FastifyInstance } from 'fastify';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { AiKnowledgeController } from '../controllers/ai-knowledge.controller.js';
import { initAiKnowledgeModule } from '../container.js';

export default async function aiKnowledgeRoutes(fastify: FastifyInstance) {
  const container = initAiKnowledgeModule(prisma);
  const controller = new AiKnowledgeController(container);
  const auth = companyAuth;

  fastify.get('/config', auth, controller.getConfig);
  fastify.put('/config', auth, controller.saveConfig);
  fastify.post('/collections', auth, controller.listCollections);
  fastify.post('/sync/collection', auth, controller.syncCollection);
  fastify.post('/sync', auth, controller.sync);
  fastify.post('/context', auth, controller.getContextForQuery);
  fastify.get('/:venueId', auth, controller.getByVenue);
}
