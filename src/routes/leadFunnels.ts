import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  createFunnel,
  createStage,
  getFunnel,
  getInsights,
  listFunnels,
  listStages,
  patchFunnel,
  patchStage,
  removeFunnel,
  removeStage,
} from '../modules/contacts_crm/lead-funnels.controller.js';
import {
  funnelIdParamsSchema,
  funnelPatchSchema,
  funnelStageParamsSchema,
  funnelStagePatchSchema,
  funnelStageWriteSchema,
  funnelWriteSchema,
} from './leadFunnels.schemas.js';

export default async function leadFunnelsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/', auth, listFunnels);
  app.post('/', { ...auth, schema: { body: funnelWriteSchema } }, createFunnel);
  app.get('/:id', { ...auth, schema: { params: funnelIdParamsSchema } }, getFunnel);
  app.get(
    '/:id/insights',
    { ...auth, schema: { params: funnelIdParamsSchema } },
    getInsights
  );
  app.patch(
    '/:id',
    { ...auth, schema: { params: funnelIdParamsSchema, body: funnelPatchSchema } },
    patchFunnel
  );
  app.delete('/:id', { ...auth, schema: { params: funnelIdParamsSchema } }, removeFunnel);
  app.get(
    '/:id/stages',
    { ...auth, schema: { params: funnelIdParamsSchema } },
    listStages
  );
  app.post(
    '/:id/stages',
    { ...auth, schema: { params: funnelIdParamsSchema, body: funnelStageWriteSchema } },
    createStage
  );
  app.patch(
    '/:id/stages/:stageId',
    { ...auth, schema: { params: funnelStageParamsSchema, body: funnelStagePatchSchema } },
    patchStage
  );
  app.delete(
    '/:id/stages/:stageId',
    { ...auth, schema: { params: funnelStageParamsSchema } },
    removeStage
  );
}
