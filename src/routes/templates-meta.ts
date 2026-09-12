import { FastifyInstance } from 'fastify';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  getHeaderMedia,
  getTemplateInsights,
  listTemplates,
  refreshTemplateStatus,
  submitTemplate,
  syncTemplates,
  uploadHeaderMedia,
} from '../modules/templates/templates-meta.controller.js';

export async function registerTemplateMetaRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/', auth, listTemplates);
  fastify.post('/sync', auth, syncTemplates);
  fastify.post('/header-media', auth, uploadHeaderMedia);
  fastify.get('/header-media/*', auth, getHeaderMedia);
  fastify.get('/:id/insights', auth, getTemplateInsights);
  fastify.post('/:id/refresh-status', auth, refreshTemplateStatus);
  fastify.post('/:id/submit', auth, submitTemplate);
}
