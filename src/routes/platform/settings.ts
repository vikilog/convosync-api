import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import {
  createPlatformMessageTemplate,
  deletePlatformMessageTemplate,
  getPlatformConfig,
  listPlatformMessageTemplates,
  updatePlatformConfig,
  updatePlatformMessageTemplate,
} from '../../services/platformSettings.service.js';

export default async function platformSettingsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/config', async () => {
    return getPlatformConfig();
  });

  fastify.put('/config', async (request, reply) => {
    const body = z
      .object({
        platformName: z.string().trim().min(1).max(80).optional(),
        supportEmail: z.string().email().nullable().optional(),
        platformPhone: z.string().trim().max(32).nullable().optional(),
        platformPhoneNumberId: z.string().trim().max(64).nullable().optional(),
        platformWabaId: z.string().trim().max(64).nullable().optional(),
        platformWaToken: z.string().trim().max(512).nullable().optional(),
      })
      .parse(request.body);

    try {
      return await updatePlatformConfig(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update config';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.get('/templates', async () => {
    const templates = await listPlatformMessageTemplates();
    return { templates };
  });

  fastify.post('/templates', async (request, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        category: z.enum(['utility', 'marketing', 'authentication']).optional(),
        language: z.string().trim().min(2).max(10).optional(),
        body: z.string().trim().min(1).max(4096),
        status: z.enum(['draft', 'approved']).optional(),
      })
      .parse(request.body);

    try {
      const template = await createPlatformMessageTemplate(body);
      return reply.code(201).send({ template });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create template';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.put('/templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        category: z.enum(['utility', 'marketing', 'authentication']).optional(),
        language: z.string().trim().min(2).max(10).optional(),
        body: z.string().trim().min(1).max(4096).optional(),
        status: z.enum(['draft', 'approved']).optional(),
      })
      .parse(request.body);

    try {
      const template = await updatePlatformMessageTemplate(id, body);
      return { template };
    } catch {
      return reply.code(404).send({ error: 'Template not found' });
    }
  });

  fastify.delete('/templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await deletePlatformMessageTemplate(id);
    } catch {
      return reply.code(404).send({ error: 'Template not found' });
    }
  });
}
