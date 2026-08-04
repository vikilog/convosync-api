import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import {
  listPlatformAuditLogs,
  type PlatformAuditCategory,
  type PlatformAuditSeverity,
} from '../../services/platformAudit.js';

const categorySchema = z.enum([
  'auth',
  'organization',
  'billing',
  'subscription',
  'security',
  'system',
]);

const severitySchema = z.enum(['info', 'warning', 'danger']);

export default async function platformAuditLogRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/', async (request) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
        category: categorySchema.optional(),
        severity: severitySchema.optional(),
        action: z.string().trim().min(1).optional(),
        search: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .parse(request.query);

    return listPlatformAuditLogs({
      page: query.page,
      pageSize: query.pageSize,
      category: query.category as PlatformAuditCategory | undefined,
      severity: query.severity as PlatformAuditSeverity | undefined,
      action: query.action,
      search: query.search,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  });
}
