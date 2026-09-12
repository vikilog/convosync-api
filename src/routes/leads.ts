import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  convertLead,
  createLead,
  listLeads,
  patchLead,
} from '../modules/contacts_crm/leads.controller.js';
import {
  leadCreateSchema,
  leadIdParamsSchema,
  leadListQuerySchema,
  leadUpdateSchema,
} from './leads.schemas.js';

export default async function leadsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/', { ...auth, schema: { querystring: leadListQuerySchema } }, listLeads);
  app.patch(
    '/:id',
    { ...auth, schema: { params: leadIdParamsSchema, body: leadUpdateSchema } },
    patchLead
  );
  app.post(
    '/:id/convert-to-contact',
    { ...auth, schema: { params: leadIdParamsSchema } },
    convertLead
  );
  app.post('/', { ...auth, schema: { body: leadCreateSchema } }, createLead);
}
