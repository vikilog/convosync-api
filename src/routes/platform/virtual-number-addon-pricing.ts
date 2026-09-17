import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { resolveVoiceProvider } from '../../config.js';

const ADDON_TYPE = z.enum(['recording', 'transcription', 'storage']);
const CURRENCY = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 code, e.g. INR, USD.');

const upsertBodySchema = z.object({
  countryIso: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO 3166 country code, e.g. IN, US, GB.'),
  addOnType: ADDON_TYPE,
  currency: CURRENCY,
  /** Major units from the form (rupees/dollars) — stored as minor units (paise/cents).
   * Not rounded: some real rates (Plivo storage, ₹0.032/min) aren't a whole minor unit. */
  ratePerMin: z.number().finite().min(0).max(100),
});

const idParamsSchema = z.object({ id: z.string() });

function serialize(row: {
  id: string;
  countryIso: string;
  provider: string;
  addOnType: string;
  currency: string;
  ratePerMinMinor: number;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    countryIso: row.countryIso,
    provider: row.provider,
    addOnType: row.addOnType,
    currency: row.currency,
    ratePerMinMinor: row.ratePerMinMinor,
    ratePerMin: row.ratePerMinMinor / 100,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** super-admin CRUD for the reference add-on rates shown on the org-facing checkout
 * page — see resolveAddOnPricing() in virtualNumber.helpers.ts for why these are
 * admin-editable rather than fetched live (neither provider's Pricing API exposes
 * a recording/transcription rate). One row per (countryIso, addOnType); `provider`
 * is derived from countryIso, not client-supplied. */
export default async function platformVirtualNumberAddOnPricingRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', authenticatePlatformAdmin);

  app.get('/', async () => {
    const items = await prisma.virtualNumberAddOnPricing.findMany({
      orderBy: [{ countryIso: 'asc' }, { addOnType: 'asc' }],
    });
    return { items: items.map(serialize) };
  });

  app.put('/', { schema: { body: upsertBodySchema } }, async (request) => {
    const body = request.body;
    const admin = getJwtUser(request);
    const provider = resolveVoiceProvider(body.countryIso);
    const ratePerMinMinor = body.ratePerMin * 100;

    const row = await prisma.virtualNumberAddOnPricing.upsert({
      where: { countryIso_addOnType: { countryIso: body.countryIso, addOnType: body.addOnType } },
      create: {
        countryIso: body.countryIso,
        provider,
        addOnType: body.addOnType,
        currency: body.currency,
        ratePerMinMinor,
        createdByPlatformAdminId: admin.platformAdminId ?? null,
      },
      update: { provider, currency: body.currency, ratePerMinMinor },
    });
    return { item: serialize(row) };
  });

  app.delete('/:id', { schema: { params: idParamsSchema } }, async (request, reply) => {
    const { id } = request.params;
    const existing = await prisma.virtualNumberAddOnPricing.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Pricing row not found' });
    await prisma.virtualNumberAddOnPricing.delete({ where: { id } });
    return { ok: true };
  });
}
