import type { FastifyInstance } from 'fastify';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { initInstagramJourneyModule } from '../container.js';
import { InstagramJourneyController } from '../controllers/ig-journey.controller.js';

export default async function instagramJourneyRoutes(fastify: FastifyInstance) {
  const container = initInstagramJourneyModule(prisma);
  const controller = new InstagramJourneyController(container);
  const auth = companyAuth;

  fastify.get('/', auth, controller.list);
  fastify.post('/', auth, controller.create);
  fastify.get('/contacts/:contactId/progress', auth, controller.contactProgress);
  fastify.get('/:id/graph', auth, controller.getGraph);
  fastify.put('/:id/graph', auth, controller.saveGraph);
  fastify.post('/:id/publish', auth, controller.publish);
  fastify.get('/:id', auth, controller.get);
  fastify.put('/:id', auth, controller.update);
  fastify.delete('/:id', auth, controller.remove);
}
