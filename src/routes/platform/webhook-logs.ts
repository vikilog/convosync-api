import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { listWebhookEventLogs } from '../../services/webhookEventLog.service.js';

export default async function platformWebhookLogRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/', async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
        source: z.string().trim().min(1).optional(),
        eventType: z.string().trim().min(1).optional(),
      })
      .parse(request.query);

    return listWebhookEventLogs({
      page: query.page,
      pageSize: query.pageSize,
      source: query.source,
      eventType: query.eventType,
    });
  });
}
