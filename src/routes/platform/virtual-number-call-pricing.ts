import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { SUPPORTED_PRICING_COUNTRIES } from '../virtualNumber.helpers.js';

const CURRENCY = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 code, e.g. INR, USD, GBP.');

const idParamsSchema = z.object({ id: z.string() });

const upsertBodySchema = z.object({
  countryIso: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO 3166 country code, e.g. IN, US, GB.'),
  countryName: z.string().trim().min(1).max(80),
  currency: CURRENCY,
  /** Major units from the form (rupees/dollars/…) — the provider's raw per-minute
   * cost, stored as minor units. Not what the workspace pays — see commissionPercent. */
  baseCostPerMin: z.number().finite().min(0).max(1_000),
  /** Platform markup, percent, on top of baseCostPerMin. 0 = resell at cost. */
  commissionPercent: z.number().finite().min(0).max(1000).default(0),
});

function serialize(row: {
  id: string;
  countryIso: string;
  countryName: string;
  currency: string;
  baseCostPerMinMinor: number;
  commissionPercent: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  const finalRatePerMinMinor = row.baseCostPerMinMinor * (1 + row.commissionPercent / 100);
  return {
    id: row.id,
    countryIso: row.countryIso,
    countryName: row.countryName,
    currency: row.currency,
    baseCostPerMinMinor: row.baseCostPerMinMinor,
    baseCostPerMin: row.baseCostPerMinMinor / 100,
    commissionPercent: row.commissionPercent,
    finalRatePerMinMinor,
    finalRatePerMin: finalRatePerMinMinor / 100,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** super-admin CRUD for the per-minute outbound CALL rate, by country — see
 * resolveCallRate() in virtualNumber.helpers.ts for the fallback (live provider
 * pricing-API call) when a country has no row here. */
export default async function platformVirtualNumberCallPricingRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', async () => {
    const items = await prisma.virtualNumberCallPricing.findMany({ orderBy: { countryName: 'asc' } });
    return {
      items: items.map(serialize),
      supportedCountries: SUPPORTED_PRICING_COUNTRIES,
    };
  });

  app.put('/', { schema: { body: upsertBodySchema } }, async (request) => {
    const body = request.body;
    const admin = getJwtUser(request);
    const baseCostPerMinMinor = body.baseCostPerMin * 100;

    const row = await prisma.virtualNumberCallPricing.upsert({
      where: { countryIso: body.countryIso },
      create: {
        countryIso: body.countryIso,
        countryName: body.countryName,
        currency: body.currency,
        baseCostPerMinMinor,
        commissionPercent: body.commissionPercent,
        createdByPlatformAdminId: admin.platformAdminId ?? null,
      },
      update: {
        countryName: body.countryName,
        currency: body.currency,
        baseCostPerMinMinor,
        commissionPercent: body.commissionPercent,
      },
    });
    return { item: serialize(row) };
  });

  app.delete('/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;
    const existing = await prisma.virtualNumberCallPricing.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Call pricing row not found' });
    await prisma.virtualNumberCallPricing.delete({ where: { id } });
    return { ok: true };
  });
}
