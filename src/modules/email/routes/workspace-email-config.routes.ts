import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { zodFlattenErrorHandler } from '../../../lib/errorHandler.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { getJwtUser } from '../../../middleware/auth.js';
import { WorkspaceEmailConfigService } from '../services/workspace-email-config.service.js';
import {
  saveWorkspaceEmailConfigSchema,
  sesCredentialsDraftBodySchema,
} from '../email.schemas.js';

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const { role } = getJwtUser(request);
  if (role !== 'admin') {
    return reply.code(403).send({ error: 'Admin only' });
  }
}

export default async function workspaceEmailConfigRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;
  const adminAuth = { onRequest: [...companyAuth.onRequest, requireAdmin] };
  const service = new WorkspaceEmailConfigService(fastify.prisma);

  app.setErrorHandler(zodFlattenErrorHandler);

  app.get('/', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });
    const config = await service.getPublic(workspaceId);
    return { config };
  });

  app.put(
    '/',
    { ...adminAuth, schema: { body: saveWorkspaceEmailConfigSchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      try {
        const config = await service.upsert(workspaceId, request.body);
        return { config };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Failed to save email config',
        });
      }
    }
  );

  app.delete('/', { onRequest: adminAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });
    const config = await service.disable(workspaceId);
    return { config };
  });

  /** Test connection (GetSendQuota) + refresh verified identity cache. */
  app.post(
    '/refresh-identities',
    { ...adminAuth, schema: { body: sesCredentialsDraftBodySchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      // Logical SES/credential failures use ok:false in the body (HTTP 200) so the UI
      // can show the message without a generic request failure.
      return service.refreshIdentities({
        workspaceId,
        draft: request.body,
      });
    }
  );

  app.post(
    '/test',
    { ...adminAuth, schema: { body: sesCredentialsDraftBodySchema } },
    async (request, reply) => {
      const { workspaceId, userId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      const user = await fastify.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      const to = user?.email?.trim();
      if (!to) {
        return reply.code(400).send({
          error: 'Your admin account has no email address to receive the test.',
        });
      }

      const result = await service.sendTestEmail({
        workspaceId,
        to,
        draft: request.body,
      });

      if (!result.ok) {
        return reply.code(400).send(result);
      }
      return result;
    }
  );
}
