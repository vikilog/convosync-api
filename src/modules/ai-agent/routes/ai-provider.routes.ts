import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { zodFlattenErrorHandler } from '../../../lib/errorHandler.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { getJwtUser } from '../../../middleware/auth.js';
import { AiProviderConfigService } from '../services/ai-provider-config.service.js';
import { LlmClientError } from '../services/llm-client.service.js';
import { AI_PROVIDER_MODELS } from '../types/ai-provider.types.js';
import { updateAiProviderSchema } from '../ai-provider.schemas.js';

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const { role } = getJwtUser(request);
  if (role !== 'admin') {
    return reply.code(403).send({ error: 'Admin only' });
  }
}

export default async function aiProviderRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;
  const adminAuth = { onRequest: [...companyAuth.onRequest, requireAdmin] };
  const service = new AiProviderConfigService(fastify.prisma);

  app.setErrorHandler(zodFlattenErrorHandler);

  app.get('/', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });
    const config = await service.getPublicConfig(workspaceId);
    return { config };
  });

  app.get('/models', { onRequest: auth.onRequest }, async () => ({ models: AI_PROVIDER_MODELS }));

  app.put(
    '/',
    { ...adminAuth, schema: { body: updateAiProviderSchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      const body = request.body;
      try {
        const config = await service.updateConfig(workspaceId, {
          mode: body.mode,
          provider: body.provider,
          model: body.model,
          apiKey: body.apiKey,
          baseUrl: body.baseUrl === '' ? null : body.baseUrl,
        });

        return { config };
      } catch (err) {
        if (err instanceof LlmClientError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    '/test',
    { onRequest: adminAuth.onRequest },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      // ponytail: POST /test historically ignored invalid body (draft=undefined) and
      // still ran testConnection. Schema here would 400 that hole; leave it.
      const parsed = updateAiProviderSchema.safeParse(request.body ?? {});
      const draft = parsed.success ? parsed.data : undefined;

      const result = await service.testConnection(workspaceId, draft);
      if (!result.ok) {
        return reply.code(400).send(result);
      }
      return result;
    }
  );
}
