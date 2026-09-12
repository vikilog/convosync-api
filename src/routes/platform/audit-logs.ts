import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { listPlatformAuditLogs } from '../../services/platformAudit.js';

const categorySchema = z.enum([
  'auth',
  'organization',
  'billing',
  'subscription',
  'security',
  'system',
]);

const severitySchema = z.enum(['info', 'warning', 'danger']);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  category: categorySchema.optional(),
  severity: severitySchema.optional(),
  action: z.string().trim().min(1).optional(),
  search: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export default async function platformAuditLogRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', { schema: { querystring: listQuerySchema } }, async (request) => {
    const query = request.query;

    return listPlatformAuditLogs({
      page: query.page,
      pageSize: query.pageSize,
      category: query.category,
      severity: query.severity,
      action: query.action,
      search: query.search,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  });
}
