import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { initJourneyModule } from '../container.js';
import { JourneyController } from '../controllers/journey.controller.js';
import {
  createJourneySchema,
  saveGraphSchema,
  triggerJourneySchema,
  updateJourneySchema,
} from '../journey.schemas.js';

export default async function journeyModuleRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const container = initJourneyModule(prisma);
  const controller = new JourneyController(container);
  const auth = companyAuth;

  app.get('/', auth, controller.list);
  app.post('/', { ...auth, schema: { body: createJourneySchema } }, controller.create);

  app.post('/trigger', { ...auth, schema: { body: triggerJourneySchema } }, controller.trigger);
  app.post('/executions/:id/resume', auth, controller.resume);
  app.get('/contacts/:contactId/progress', auth, controller.contactProgress);

  app.get('/:id/graph', auth, controller.getGraph);
  app.put('/:id/graph', { ...auth, schema: { body: saveGraphSchema } }, controller.saveGraph);
  app.post('/:id/publish', auth, controller.publish);
  app.get('/:id/analytics', auth, controller.analytics);

  app.get('/:id', auth, controller.get);
  app.put('/:id', { ...auth, schema: { body: updateJourneySchema } }, controller.update);
  app.delete('/:id', auth, controller.remove);
}
