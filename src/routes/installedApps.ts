import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { installApp, listInstalledApps, uninstallApp } from '../services/installedApps.service.js';
import { installedAppParamsSchema } from './installedApps.schemas.js';

export default async function installedAppsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const appIds = await listInstalledApps(workspaceId);
    return { appIds };
  });

  app.post(
    '/:appId',
    { ...auth, schema: { params: installedAppParamsSchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { appId } = request.params;
    if (!appId) return reply.code(400).send({ error: 'appId is required' });
    await installApp(workspaceId, appId);
    return reply.code(201).send({ success: true });
  });

  app.delete(
    '/:appId',
    { ...auth, schema: { params: installedAppParamsSchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { appId } = request.params;
    await uninstallApp(workspaceId, appId);
    return { success: true };
  });
}
