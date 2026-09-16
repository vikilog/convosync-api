import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  createTemplateGroup,
  deleteTemplateGroup,
  listTemplateGroups,
  updateTemplateGroup,
} from '../modules/templates/templateGroups.controller.js';
import { templateGroupBodySchema, templateGroupUpdateSchema } from './templateGroups.schemas.js';

/** User-defined folders for organizing WhatsApp templates (e.g. "Product", "Service",
 * "Feedback") — see Template.groupId. Purely local; unrelated to Meta's template category. */
export default async function templateGroupRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/', auth, listTemplateGroups);
  app.post('/', { ...auth, schema: { body: templateGroupBodySchema } }, createTemplateGroup);
  app.put('/:id', { ...auth, schema: { body: templateGroupUpdateSchema } }, updateTemplateGroup);
  app.delete('/:id', auth, deleteTemplateGroup);
}
