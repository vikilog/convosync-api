import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { SUPPORTED_PRICING_COUNTRIES } from '../virtualNumber.helpers.js';

const NUMBER_TYPE = z.enum(['local', 'tollfree']);
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
  numberType: NUMBER_TYPE.default('local'),
  currency: CURRENCY,
  /** Major units from the form (rupees/dollars/pounds) — the provider's raw cost,
   * stored as minor units. Not what the workspace pays — see commissionPercent. */
  monthlyPrice: z.number().finite().min(0).max(1_000_000),
  /** Platform markup, percent, on top of monthlyPrice. 0 = resell at cost. */
  commissionPercent: z.number().finite().min(0).max(1000).default(0),
});

function serialize(row: {
  id: string;
  countryIso: string;
  countryName: string;
  numberType: string;
  currency: string;
  monthlyPriceMinor: number;
  commissionPercent: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  const finalPriceMinor = Math.round(row.monthlyPriceMinor * (1 + row.commissionPercent / 100));
  return {
    id: row.id,
    countryIso: row.countryIso,
    countryName: row.countryName,
    numberType: row.numberType,
    currency: row.currency,
    monthlyPriceMinor: row.monthlyPriceMinor,
    monthlyPrice: row.monthlyPriceMinor / 100,
    commissionPercent: row.commissionPercent,
    finalPriceMinor,
    finalPrice: finalPriceMinor / 100,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function platformVirtualNumberPricingRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', async () => {
    const items = await prisma.virtualNumberPricing.findMany({
      orderBy: [{ countryName: 'asc' }, { numberType: 'asc' }],
    });
    return {
      items: items.map(serialize),
      supportedCountries: SUPPORTED_PRICING_COUNTRIES,
    };
  });

  // Upsert (create-or-update) keyed by the same (countryIso, numberType) pair the
  // pricing lookup in virtualNumber.helpers.ts reads by — one row per combination.
  app.put('/', { schema: { body: upsertBodySchema } }, async (request) => {
    const body = request.body;
    const admin = getJwtUser(request);
    const monthlyPriceMinor = Math.round(body.monthlyPrice * 100);

    const row = await prisma.virtualNumberPricing.upsert({
      where: { countryIso_numberType: { countryIso: body.countryIso, numberType: body.numberType } },
      create: {
        countryIso: body.countryIso,
        countryName: body.countryName,
        numberType: body.numberType,
        currency: body.currency,
        monthlyPriceMinor,
        commissionPercent: body.commissionPercent,
        createdByPlatformAdminId: admin.platformAdminId ?? null,
      },
      update: {
        countryName: body.countryName,
        currency: body.currency,
        monthlyPriceMinor,
        commissionPercent: body.commissionPercent,
      },
    });
    return { item: serialize(row) };
  });

  app.delete('/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;
    const existing = await prisma.virtualNumberPricing.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Pricing row not found' });
    await prisma.virtualNumberPricing.delete({ where: { id } });
    return { ok: true };
  });
}
