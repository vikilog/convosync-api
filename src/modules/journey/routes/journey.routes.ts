import type { FastifyInstance } from 'fastify';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { initJourneyModule } from '../container.js';
import { JourneyController } from '../controllers/journey.controller.js';

export default async function journeyModuleRoutes(fastify: FastifyInstance) {
  const container = initJourneyModule(prisma);
  const controller = new JourneyController(container);
  const auth = companyAuth;

  fastify.get('/', auth, controller.list);
  fastify.post('/', auth, controller.create);

  fastify.post('/trigger', auth, controller.trigger);
  fastify.post('/executions/:id/resume', auth, controller.resume);
  fastify.get('/contacts/:contactId/progress', auth, controller.contactProgress);

  fastify.get('/:id/graph', auth, controller.getGraph);
  fastify.put('/:id/graph', auth, controller.saveGraph);
  fastify.post('/:id/publish', auth, controller.publish);
  fastify.get('/:id/analytics', auth, controller.analytics);

  fastify.get('/:id', auth, controller.get);
  fastify.put('/:id', auth, controller.update);
  fastify.delete('/:id', auth, controller.remove);
}
