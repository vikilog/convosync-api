import { FastifyInstance } from 'fastify';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { installApp, listInstalledApps, uninstallApp } from '../services/installedApps.service.js';

export default async function installedAppsRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const appIds = await listInstalledApps(workspaceId);
    return { appIds };
  });

  fastify.post('/:appId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { appId } = request.params as { appId: string };
    if (!appId) return reply.code(400).send({ error: 'appId is required' });
    await installApp(workspaceId, appId);
    return reply.code(201).send({ success: true });
  });

  fastify.delete('/:appId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { appId } = request.params as { appId: string };
    await uninstallApp(workspaceId, appId);
    return { success: true };
  });
}
