import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { initInstagramJourneyModule } from '../container.js';
import { InstagramJourneyController } from '../controllers/ig-journey.controller.js';
import {
  createIgJourneySchema,
  saveIgGraphSchema,
  updateIgJourneySchema,
} from '../ig-journey.schemas.js';

export default async function instagramJourneyRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const container = initInstagramJourneyModule(prisma);
  const controller = new InstagramJourneyController(container);
  const auth = companyAuth;

  app.get('/', auth, controller.list);
  app.post('/', { ...auth, schema: { body: createIgJourneySchema } }, controller.create);
  app.get('/contacts/:contactId/progress', auth, controller.contactProgress);
  app.post('/executions/:id/resume', auth, controller.resume);
  app.get('/:id/graph', auth, controller.getGraph);
  app.put('/:id/graph', { ...auth, schema: { body: saveIgGraphSchema } }, controller.saveGraph);
  app.post('/:id/publish', auth, controller.publish);
  app.get('/:id', auth, controller.get);
  app.put('/:id', { ...auth, schema: { body: updateIgJourneySchema } }, controller.update);
  app.delete('/:id', auth, controller.remove);
}
