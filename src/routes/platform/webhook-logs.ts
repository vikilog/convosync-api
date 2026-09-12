import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { listWebhookEventLogs } from '../../services/webhookEventLog.service.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  source: z.string().trim().min(1).optional(),
  eventType: z.string().trim().min(1).optional(),
});

export default async function platformWebhookLogRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', { schema: { querystring: listQuerySchema } }, async (request) => {
    const query = request.query;

    return listWebhookEventLogs({
      page: query.page,
      pageSize: query.pageSize,
      source: query.source,
      eventType: query.eventType,
    });
  });
}
