import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';

const upsertBodySchema = z.object({
  countryIso: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO 3166 country code, e.g. IN, US, GB.'),
  countryName: z.string().trim().min(1).max(80),
  taxLabel: z.string().trim().min(1).max(20).default('Tax'),
  taxRatePercent: z.number().finite().min(0).max(100),
});

const idParamsSchema = z.object({ id: z.string() });

function serialize(row: {
  id: string;
  countryIso: string;
  countryName: string;
  taxLabel: string;
  taxRatePercent: number;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    countryIso: row.countryIso,
    countryName: row.countryName,
    taxLabel: row.taxLabel,
    taxRatePercent: row.taxRatePercent,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** super-admin CRUD for per-country checkout tax rates — see resolveTax() in
 * virtualNumber.helpers.ts for the fallback rule when a country has no row here. */
export default async function platformVirtualNumberTaxRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', async () => {
    const items = await prisma.virtualNumberCountryTax.findMany({ orderBy: { countryName: 'asc' } });
    return { items: items.map(serialize) };
  });

  app.put('/', { schema: { body: upsertBodySchema } }, async (request) => {
    const body = request.body;
    const admin = getJwtUser(request);

    const row = await prisma.virtualNumberCountryTax.upsert({
      where: { countryIso: body.countryIso },
      create: {
        countryIso: body.countryIso,
        countryName: body.countryName,
        taxLabel: body.taxLabel,
        taxRatePercent: body.taxRatePercent,
        createdByPlatformAdminId: admin.platformAdminId ?? null,
      },
      update: { countryName: body.countryName, taxLabel: body.taxLabel, taxRatePercent: body.taxRatePercent },
    });
    return { item: serialize(row) };
  });

  app.delete('/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;
    const existing = await prisma.virtualNumberCountryTax.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Tax row not found' });
    await prisma.virtualNumberCountryTax.delete({ where: { id } });
    return { ok: true };
  });
}
