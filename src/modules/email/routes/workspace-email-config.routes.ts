import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { getJwtUser } from '../../../middleware/auth.js';
import { WorkspaceEmailConfigService } from '../services/workspace-email-config.service.js';

const credentialsDraftSchema = z.object({
  accessKeyId: z.string().min(1).max(200).optional(),
  secretAccessKey: z.string().min(1).max(500).optional(),
  region: z.string().min(1).max(64).optional(),
  senderEmail: z.string().email().max(320).optional(),
});

const saveSchema = z.object({
  useOwnEmail: z.boolean(),
  accessKeyId: z.string().min(1).max(200).optional(),
  secretAccessKey: z.string().min(1).max(500).optional(),
  region: z.string().min(1).max(64).optional(),
  senderEmail: z.string().email().max(320).optional(),
});

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const { role } = getJwtUser(request);
  if (role !== 'admin') {
    void reply.code(403).send({ error: 'Admin only' });
    return false;
  }
  return true;
}

export default async function workspaceEmailConfigRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;
  const service = new WorkspaceEmailConfigService(fastify.prisma);

  fastify.get(
    '/',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });
      const config = await service.getPublic(workspaceId);
      return { config };
    }
  );

  fastify.put(
    '/',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      const parsed = saveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        const config = await service.upsert(workspaceId, parsed.data);
        return { config };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : 'Failed to save email config',
        });
      }
    }
  );

  fastify.delete(
    '/',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });
      const config = await service.disable(workspaceId);
      return { config };
    }
  );

  /** Test connection (GetSendQuota) + refresh verified identity cache. */
  fastify.post(
    '/refresh-identities',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      const parsed = credentialsDraftSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      // Logical SES/credential failures use ok:false in the body (HTTP 200) so the UI
      // can show the message without a generic request failure.
      return service.refreshIdentities({
        workspaceId,
        draft: parsed.data,
      });
    }
  );

  fastify.post(
    '/test',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { workspaceId, userId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      const parsed = credentialsDraftSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

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
        draft: parsed.data,
      });

      if (!result.ok) {
        return reply.code(400).send(result);
      }
      return result;
    }
  );
}
