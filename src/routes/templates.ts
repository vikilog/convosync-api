import multipart from '@fastify/multipart';
import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  updateTemplate,
} from '../modules/templates/templates.controller.js';
import { registerTemplateMetaRoutes } from './templates-meta.js';
import { templateBodySchema, templateUpdateSchema } from './templates.schemas.js';

export default async function templateRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  await fastify.register(multipart, {
    limits: { fileSize: 16 * 1024 * 1024 },
  });

  await registerTemplateMetaRoutes(fastify);

  fastify.get('/:id', auth, getTemplate);
  app.post('/', { ...auth, schema: { body: templateBodySchema } }, createTemplate);
  app.put('/:id', { ...auth, schema: { body: templateUpdateSchema } }, updateTemplate);
  fastify.delete('/:id', auth, deleteTemplate);
}
