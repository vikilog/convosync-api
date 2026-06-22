import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { getJwtUser } from '../../../middleware/auth.js';
import { AiProviderConfigService } from '../services/ai-provider-config.service.js';
import { LlmClientError } from '../services/llm-client.service.js';
import {
  AI_PROVIDER_MODELS,
  type AiProviderMode,
  type AiProviderType,
} from '../types/ai-provider.types.js';

const updateSchema = z.object({
  mode: z.enum(['convosync', 'byok']).optional(),
  provider: z.enum(['openai', 'anthropic', 'custom']).optional(),
  model: z.string().min(1).max(120).optional(),
  apiKey: z.string().min(8).max(500).optional(),
  baseUrl: z.union([z.string().url().max(500), z.literal(''), z.null()]).optional(),
});

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const { role } = getJwtUser(request);
  if (role !== 'admin') {
    void reply.code(403).send({ error: 'Admin only' });
    return false;
  }
  return true;
}

export default async function aiProviderRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;
  const service = new AiProviderConfigService(fastify.prisma);

  fastify.get(
    '/',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });
      const config = await service.getPublicConfig(workspaceId);
      return { config };
    }
  );

  fastify.get(
    '/models',
    { onRequest: auth.onRequest },
    async () => ({ models: AI_PROVIDER_MODELS })
  );

  fastify.put(
    '/',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const body = parsed.data;
      try {
        const config = await service.updateConfig(workspaceId, {
          mode: body.mode as AiProviderMode | undefined,
          provider: body.provider as AiProviderType | undefined,
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

  fastify.post(
    '/test',
    { onRequest: auth.onRequest },
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(400).send({ error: 'Workspace required' });

      const parsed = updateSchema.safeParse(request.body ?? {});
      const draft = parsed.success ? parsed.data : undefined;

      const result = await service.testConnection(workspaceId, draft);
      if (!result.ok) {
        return reply.code(400).send(result);
      }
      return result;
    }
  );
}
