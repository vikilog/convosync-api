import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../lib/prisma.js';
import { whatsappCanonicalDigits } from '../lib/whatsappContact.js';
import {
  availableNumbersQuerySchema,
  callLogQuerySchema,
  numberSettingsBodySchema,
  payVerifyBodySchema,
  placeCallBodySchema,
  requestAccessBodySchema,
  selectNumberBodySchema,
} from './virtualNumber.schemas.js';
import { companyAuth, companyAuthBilling } from '../middleware/workspaceScope.js';
import { getJwtUser } from '../middleware/auth.js';
import { config, resolveVoiceProvider } from '../config.js';
import { RazorpayService } from '../modules/billing/razorpay.service.js';
import { verifyRazorpayPaymentSignature } from '../utils/crypto.utils.js';
import type { SupportedCountryIso } from '../services/voiceProvider.types.js';
import {
  CALL_MARKUP_RATE,
  TERMINAL_OR_ACTIVE,
  findActiveById,
  findActiveNumbers,
  findLatest,
  lookupContactNames,
  otherPartyDigits,
  outboundPerMinInrPaise,
  priceForType,
  providerFor,
  serialize,
  serializeNumber,
  toCallLogEntry,
  withGst,
  type VirtualNumberRow,
} from './virtualNumber.helpers.js';
import registerPlivoWebhooks, { ensurePlivoBrowserCalling } from './virtualNumberWebhooks.plivo.js';
import registerTelnyxWebhooks, { ensureTelnyxBrowserCalling } from './virtualNumberWebhooks.telnyx.js';

/**
 * Virtual Number request → admin approval → pick a number → pay → activate.
 * Admin approval lives in the super-admin app (routes/platform/virtual-number-requests.ts).
 * The actual number purchase only happens after a verified Razorpay payment (real money).
 *
 * Backed by either Plivo (India) or Telnyx (US/GB/SG) — `row.provider` is decided once,
 * from the workspace's country, at `/request-access` time (see resolveVoiceProvider in
 * config.ts) and every route below just dispatches on it via `providerFor(row)`.
 *
 * A workspace can hold several numbers at once. `GET /` tracks the single latest
 * request — it drives the acquire-a-number wizard (pending/select/pay/active) and stays
 * a single row on purpose, since only one purchase is ever in flight at a time. Once a
 * request reaches `active`, it also shows up in `GET /numbers`, the list of every number
 * the workspace actually owns — that's what Calls, Settings, and browser calling use.
 */

function ensureBrowserCalling(row: VirtualNumberRow) {
  return row.provider === 'telnyx' ? ensureTelnyxBrowserCalling(row) : ensurePlivoBrowserCalling(row);
}

export default async function virtualNumberRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const razorpay = new RazorpayService(fastify);

  app.get('/', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest) return { stage: 'not_requested' };
    return serialize(latest);
  });

  /** Every number this workspace actually owns — used by Calls, Settings, and browser calling. */
  app.get('/numbers', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const numbers = await findActiveNumbers(workspaceId);
    return { numbers: numbers.map(serializeNumber) };
  });

  /** This contact's calls across every number the workspace owns — for the Contact detail page. */
  app.get('/calls/for-contact/:contactId', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { contactId } = request.params as { contactId: string };
    const contact = await prisma.contact.findFirst({ where: { id: contactId, workspaceId } });
    if (!contact) return reply.code(404).send({ error: 'Contact not found' });

    const numbers = await findActiveNumbers(workspaceId);
    const numbersWithSelection = numbers.filter(
      (row): row is VirtualNumberRow & { selectedNumber: string } => Boolean(row.selectedNumber),
    );
    if (numbersWithSelection.length === 0) return { source: 'mock', entries: [] };

    const canonical = whatsappCanonicalDigits(contact.phone);
    if (!canonical) return { source: 'plivo', entries: [] };

    try {
      const perNumber = await Promise.all(
        numbersWithSelection.map(async (row) => {
          const svc = providerFor(row);
          try {
            const [{ records }, recordedUuids] = await Promise.all([
              svc.listCalls({ number: row.selectedNumber, limit: 30 }),
              svc.listRecordedCallUuids(30),
            ]);
            return records
              .filter((r) => whatsappCanonicalDigits(otherPartyDigits(r, row.selectedNumber)) === canonical)
              .map((r) => ({
                ...toCallLogEntry(
                  r,
                  row.selectedNumber,
                  (raw) => svc.formatDisplayNumber(raw, (row.selectedCountryIso ?? undefined) as SupportedCountryIso | undefined),
                  recordedUuids.has(r.callUuid),
                  { id: contact.id, name: contact.name },
                ),
                numberId: row.id,
                numberLabel: row.label,
              }));
          } catch {
            return [];
          }
        }),
      );

      const entries = perNumber
        .flat()
        .sort((a, b) => (b.startedAt ? Date.parse(b.startedAt) : 0) - (a.startedAt ? Date.parse(a.startedAt) : 0))
        .slice(0, 20);

      return { source: 'plivo', entries };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Call log fetch failed' });
    }
  });

  app.get(
    '/:id/call-log',
    { onRequest: companyAuth.onRequest, schema: { querystring: callLogQuerySchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      const { id } = request.params as { id: string };
      const query = request.query;
      const row = await findActiveById(workspaceId, id);
      if (!row?.selectedNumber) {
        return reply.code(404).send({ error: 'No such active number for this workspace.' });
      }

      const svc = providerFor(row);
      try {
        const [{ records, hasMore }, recordedUuids] = await Promise.all([
          svc.listCalls({ number: row.selectedNumber, limit: query.limit, offset: query.cursor }),
          svc.listRecordedCallUuids(30),
        ]);
        const digitsByRecord = records.map((r) => otherPartyDigits(r, row.selectedNumber!));
        const contactsByDigits = await lookupContactNames(workspaceId, digitsByRecord);
        return {
          source: row.provider,
          entries: records.map((r, i) =>
            toCallLogEntry(
              r,
              row.selectedNumber!,
              (raw) => svc.formatDisplayNumber(raw, (row.selectedCountryIso ?? undefined) as SupportedCountryIso | undefined),
              recordedUuids.has(r.callUuid),
              contactsByDigits.get(digitsByRecord[i]) ?? null,
            ),
          ),
          nextCursor: hasMore ? query.cursor + query.limit : null,
        };
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'Call log fetch failed' });
      }
    },
  );

  app.get('/:id/call-log/:callUuid', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id, callUuid } = request.params as { id: string; callUuid: string };
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }

    const svc = providerFor(row);
    try {
      const [detail, transcript] = await Promise.all([
        svc.getCallDetail(callUuid),
        prisma.plivoCallTranscript.findUnique({ where: { callUuid } }),
      ]);
      const otherDigits = otherPartyDigits(detail, row.selectedNumber);
      const namesByDigits = await lookupContactNames(workspaceId, [otherDigits]);
      const entry = toCallLogEntry(
        detail,
        row.selectedNumber,
        (raw) => svc.formatDisplayNumber(raw, (row.selectedCountryIso ?? undefined) as SupportedCountryIso | undefined),
        Boolean(detail.recordUrl),
        namesByDigits.get(otherDigits) ?? null,
      );
      return {
        ...entry,
        recordUrl: detail.recordUrl,
        hangupCause: detail.hangupCause,
        transcript: transcript?.text ?? null,
        callUuid: detail.callUuid,
        answerTime: detail.answerTime,
        ringDurationSeconds: detail.ringDurationSeconds,
        postDialDelaySeconds: detail.postDialDelaySeconds,
        hangupCauseCode: detail.hangupCauseCode,
        hangupSource: detail.hangupSource,
        stirVerification: detail.stirVerification,
        sourceIp: detail.sourceIp,
        // Providers report cost in USD — convert so it matches every other price shown in the app (₹).
        totalCostInrPaise: detail.totalAmount ? Math.round(parseFloat(detail.totalAmount) * 85 * 100) : null,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not load this call.' });
    }
  });

  /** Placing a call spends real per-minute money on the connected provider account. */
  app.post(
    '/:id/call',
    { onRequest: companyAuth.onRequest, schema: { body: placeCallBodySchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      const { id } = request.params as { id: string };
      const row = await findActiveById(workspaceId, id);
      if (!row?.selectedNumber) {
        return reply.code(404).send({ error: 'No such active number for this workspace.' });
      }
      const providerEnabled = row.provider === 'telnyx' ? config.telnyx.enabled : config.plivo.enabled;
      if (!providerEnabled) {
        return reply.code(409).send({ error: `${row.provider} is not configured on this server.` });
      }

      const toDigits = request.body.to.replace(/\D/g, '');
      const webhookPrefix = row.provider === 'telnyx' ? '/telnyx' : '';

      try {
        const result = await providerFor(row).makeCall({
          from: row.selectedNumber,
          to: toDigits,
          answerUrl: `${config.backendPublicUrl}/api/virtual-number${webhookPrefix}/answer-xml`,
          hangupUrl: `${config.backendPublicUrl}/api/virtual-number${webhookPrefix}/hangup-xml`,
        });
        return { requestUuid: result.requestUuid, message: result.message };
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not place the call.' });
      }
    },
  );

  // --- Provider webhooks: no auth — Plivo/Telnyx's own servers call these directly. ---
  registerPlivoWebhooks(app);
  registerTelnyxWebhooks(app);

  /** Credentials for the workspace's browser (Plivo Browser SDK or Telnyx WebRTC SDK) to log
   * in with — one shared identity for the whole workspace, however many numbers it owns.
   * Creates it on first use. `provider` tells the frontend which SDK to boot. */
  app.get('/browser-credentials', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const numbers = await findActiveNumbers(workspaceId);
    if (numbers.length === 0) {
      return reply.code(409).send({ error: 'No active virtual number for this workspace.' });
    }

    const seed = numbers.find((n) => n.plivoEndpointUsername) ?? numbers[0];
    const providerEnabled = seed.provider === 'telnyx' ? config.telnyx.enabled : config.plivo.enabled;
    if (!providerEnabled) {
      return reply.code(409).send({ error: `${seed.provider} is not configured on this server.` });
    }

    try {
      const withCreds = await ensureBrowserCalling(seed);
      if (!withCreds.plivoEndpointUsername || !withCreds.plivoEndpointPassword) {
        return reply.code(502).send({ error: 'Could not set up browser calling for this workspace.' });
      }
      // Any numbers still missing inbound routing (e.g. added before browser calling existed)
      // get linked to the now-shared Endpoint/Application too.
      await Promise.all(
        numbers.filter((n) => n.id !== seed.id && !n.plivoEndpointUsername).map((n) => ensureBrowserCalling(n).catch(() => {})),
      );
      return { username: withCreds.plivoEndpointUsername, password: withCreds.plivoEndpointPassword, provider: seed.provider };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not set up browser calling.' });
    }
  });

  /** Kicks off getting a number — always starts a fresh request, so a workspace that
   * already has active numbers can request another one alongside them. Decides the
   * provider once, from the workspace's country, and locks it onto the request row. */
  app.post(
    '/request-access',
    { onRequest: companyAuth.onRequest, schema: { body: requestAccessBodySchema } },
    async (request, reply) => {
      const { workspaceId, userId } = getJwtUser(request);
      if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      const body = request.body;

      const latest = await findLatest(workspaceId);
      // Idempotent: an in-flight (not yet active/rejected) request already covers this — just report it.
      if (latest && !TERMINAL_OR_ACTIVE.has(latest.status)) {
        return serialize(latest);
      }

      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { country: true } });
      const provider = resolveVoiceProvider(workspace?.country);

      const created = await prisma.virtualNumberRequest.create({
        data: {
          workspaceId,
          requestedByUserId: userId ?? null,
          status: 'pending_approval',
          label: body.label || null,
          description: body.description || null,
          provider,
        },
      });
      return serialize(created);
    },
  );

  app.get(
    '/available-numbers',
    { onRequest: companyAuth.onRequest, schema: { querystring: availableNumbersQuerySchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      const latest = await findLatest(workspaceId);
      if (!latest || !['approved', 'number_selected', 'paid'].includes(latest.status)) {
        return reply.code(409).send({ error: 'Request has not been approved yet.' });
      }

      const query = request.query;
      const providerEnabled = latest.provider === 'telnyx' ? config.telnyx.enabled : config.plivo.enabled;

      if (!providerEnabled) {
        // Dev fallback so the flow is walkable without real provider credentials.
        const mockByProvider: Record<string, { number: string; displayNumber: string; city: string }[]> = {
          plivo: [
            { number: '912264231648', displayNumber: '+91 22 6423 1648', city: 'Mumbai' },
            { number: '912264231645', displayNumber: '+91 22 6423 1645', city: 'Mumbai' },
            { number: '918047182032', displayNumber: '+91 80 4718 2032', city: 'Bengaluru' },
          ],
          telnyx: [
            { number: '14155550100', displayNumber: '+1 (415) 555-0100', city: 'San Francisco' },
            { number: '442071234567', displayNumber: '+44 2071234567', city: 'London' },
            { number: '6531234567', displayNumber: '+65 3123 4567', city: 'Singapore' },
          ],
        };
        const all = (mockByProvider[latest.provider] ?? mockByProvider.plivo).map((n) => ({
          ...n,
          type: 'fixed',
          priceInrPaise: priceForType('fixed'),
        }));
        return { source: 'mock', numbers: all, totalCount: all.length, hasMore: false };
      }

      try {
        // Before a number is selected, selectedCountryIso is still null — fall back to the
        // workspace's own country so e.g. a Singapore workspace searches SG numbers instead
        // of whichever country each provider happens to default to internally.
        const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { country: true } });
        const countryIso = (latest.selectedCountryIso ?? workspace?.country ?? undefined) as
          | SupportedCountryIso
          | undefined;
        const results = await providerFor(latest).searchAvailableNumbers({
          countryIso,
          pattern: query.pattern,
          offset: query.offset,
          limit: query.limit,
        });
        return {
          source: latest.provider,
          numbers: results.numbers.map((n) => ({
            number: n.number,
            displayNumber: n.displayNumber,
            city: n.city ?? n.region,
            type: n.type,
            priceInrPaise: priceForType(n.type),
          })),
          totalCount: results.totalCount,
          hasMore: results.hasMore,
        };
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'Number search failed' });
      }
    },
  );

  app.post(
    '/select-number',
    { onRequest: companyAuth.onRequest, schema: { body: selectNumberBodySchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      const body = request.body;

      const latest = await findLatest(workspaceId);
      if (!latest || !['approved', 'number_selected'].includes(latest.status)) {
        return reply.code(409).send({ error: 'Request is not ready for number selection.' });
      }

      const updated = await prisma.virtualNumberRequest.update({
        where: { id: latest.id },
        data: {
          status: 'number_selected',
          selectedNumber: body.number,
          selectedCity: body.city ?? null,
          selectedCountryIso: body.countryIso ?? null,
          selectedPriceInrPaise: body.priceInrPaise,
        },
      });
      return serialize(updated);
    },
  );

  app.post('/pay/create-order', { onRequest: companyAuthBilling.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest || latest.status !== 'number_selected' || !latest.selectedPriceInrPaise) {
      return reply.code(409).send({ error: 'Select a number before paying.' });
    }

    try {
      const totalInrPaise = withGst(latest.selectedPriceInrPaise);
      const order = await razorpay.createOrder({
        amountPaise: totalInrPaise,
        currency: 'INR',
        receipt: `vnum_${workspaceId.slice(-8)}_${Date.now()}`,
        notes: { workspaceId, virtualNumberRequestId: latest.id, purpose: 'virtual_number_purchase' },
      });

      await prisma.virtualNumberRequest.update({
        where: { id: latest.id },
        data: { razorpayOrderId: order.id },
      });

      return {
        orderId: order.id,
        amountPaise: totalInrPaise,
        baseAmountPaise: latest.selectedPriceInrPaise,
        gstPaise: totalInrPaise - latest.selectedPriceInrPaise,
        currency: 'INR',
        keyId: razorpay.keyId,
      };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Could not start payment.' });
    }
  });

  app.post(
    '/pay/verify',
    { onRequest: companyAuthBilling.onRequest, schema: { body: payVerifyBodySchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      const body = request.body;

      const latest = await findLatest(workspaceId);
      if (!latest || latest.razorpayOrderId !== body.razorpay_order_id) {
        return reply.code(404).send({ error: 'No matching order for this workspace.' });
      }
      if (latest.status === 'active') return serialize(latest); // already settled — idempotent

      const validSignature = verifyRazorpayPaymentSignature(
        body.razorpay_order_id,
        body.razorpay_payment_id,
        body.razorpay_signature,
        config.razorpay.keySecret,
      );
      if (!validSignature) return reply.code(400).send({ error: 'Invalid payment signature.' });

      const paid = await prisma.virtualNumberRequest.update({
        where: { id: latest.id },
        data: { status: 'paid', razorpayPaymentId: body.razorpay_payment_id, paidAt: new Date() },
      });

      if (!paid.selectedNumber) {
        return reply.code(500).send({ error: 'Payment recorded but no number was selected.' });
      }

      // Real money already moved — the provider purchase happens after, and failures
      // here are recoverable (purchaseError is surfaced so support can retry).
      try {
        const providerEnabled = paid.provider === 'telnyx' ? config.telnyx.enabled : config.plivo.enabled;
        const bought = providerEnabled
          ? await providerFor(paid).buyNumber(paid.selectedNumber, `workspace:${workspaceId}`)
          : { providerNumberId: `mock_${paid.selectedNumber}` };

        const active = await prisma.virtualNumberRequest.update({
          where: { id: paid.id },
          data: {
            status: 'active',
            plivoNumberId: bought.providerNumberId,
            activatedAt: new Date(),
            purchaseError: null,
          },
        });

        // Browser calling (Endpoint + inbound routing) — best-effort, doesn't block activation.
        // The /browser-credentials route retries this lazily if it fails here.
        try {
          await ensureBrowserCalling(active);
        } catch {
          // ignored — number is active either way; browser calling can be provisioned later
        }

        return serialize(active);
      } catch (err) {
        const failed = await prisma.virtualNumberRequest.update({
          where: { id: paid.id },
          data: { purchaseError: err instanceof Error ? err.message : 'Number purchase failed' },
        });
        return reply.code(502).send({ ...serialize(failed), error: failed.purchaseError });
      }
    },
  );

  /** Real per-minute call cost for this number, with our 10% markup applied. */
  app.get('/:id/pricing', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }

    const providerEnabled = row.provider === 'telnyx' ? config.telnyx.enabled : config.plivo.enabled;
    if (!providerEnabled) {
      const mockCountry: Record<string, { countryIso: string; countryName: string; usdPerMin: number }> = {
        plivo: { countryIso: 'IN', countryName: 'India', usdPerMin: 0.0046 },
        telnyx: { countryIso: 'US', countryName: 'United States', usdPerMin: 0.007 },
      };
      const mock = mockCountry[row.provider] ?? mockCountry.plivo;
      return {
        countryIso: mock.countryIso,
        countryName: mock.countryName,
        outboundPerMinInrPaise: outboundPerMinInrPaise(mock.usdPerMin),
        markupRate: CALL_MARKUP_RATE,
        source: 'mock',
      };
    }

    try {
      const pricing = await providerFor(row).getVoicePricing((row.selectedCountryIso as SupportedCountryIso) ?? undefined);
      return {
        countryIso: pricing.countryIso,
        countryName: pricing.countryName,
        outboundPerMinInrPaise: outboundPerMinInrPaise(pricing.outboundRatePerMinUsd),
        markupRate: CALL_MARKUP_RATE,
        source: row.provider,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not fetch call pricing.' });
    }
  });

  /** Updates a number's display name, description, and/or missed-call auto-reply configuration. */
  app.patch(
    '/:id/settings',
    { onRequest: companyAuth.onRequest, schema: { body: numberSettingsBodySchema } },
    async (request, reply) => {
      const { workspaceId } = getJwtUser(request);
      if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

      const { id } = request.params as { id: string };
      const row = await findActiveById(workspaceId, id);
      if (!row) return reply.code(404).send({ error: 'No such active number for this workspace.' });

      const body = request.body;

      const updated = await prisma.virtualNumberRequest.update({
        where: { id: row.id },
        data: {
          ...(body.label !== undefined && { label: body.label || null }),
          ...(body.description !== undefined && { description: body.description || null }),
          ...(body.missedCallAutoReplyEnabled !== undefined && {
            missedCallAutoReplyEnabled: body.missedCallAutoReplyEnabled,
          }),
          ...(body.missedCallMessage !== undefined && { missedCallMessage: body.missedCallMessage || null }),
          ...(body.missedCallTemplateId !== undefined && { missedCallTemplateId: body.missedCallTemplateId || null }),
          ...(body.userMissedCallAutoReplyEnabled !== undefined && {
            userMissedCallAutoReplyEnabled: body.userMissedCallAutoReplyEnabled,
          }),
          ...(body.userMissedCallMessage !== undefined && {
            userMissedCallMessage: body.userMissedCallMessage || null,
          }),
          ...(body.userMissedCallTemplateId !== undefined && {
            userMissedCallTemplateId: body.userMissedCallTemplateId || null,
          }),
        },
      });
      return serialize(updated);
    },
  );

  /** Permanently releases this number back to the provider — irreversible, stops billing. */
  app.post('/:id/release', { onRequest: companyAuthBilling.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const row = await findActiveById(workspaceId, id);
    if (!row?.selectedNumber) {
      return reply.code(404).send({ error: 'No such active number for this workspace.' });
    }

    try {
      const providerEnabled = row.provider === 'telnyx' ? config.telnyx.enabled : config.plivo.enabled;
      if (providerEnabled) {
        const svc = providerFor(row);
        await svc.releaseNumber(row.selectedNumber);
        // Only tear down the shared Endpoint/Application if no other number still uses them.
        const stillShared = await prisma.virtualNumberRequest.findFirst({
          where: { workspaceId, status: 'active', id: { not: row.id }, plivoEndpointId: row.plivoEndpointId },
        });
        if (!stillShared) {
          if (row.plivoEndpointId) await svc.deleteEndpoint(row.plivoEndpointId).catch(() => {});
          if (row.plivoAppId) await svc.deleteApplication(row.plivoAppId).catch(() => {});
        }
      }
      const released = await prisma.virtualNumberRequest.update({
        where: { id: row.id },
        data: { status: 'released', releasedAt: new Date() },
      });
      return serialize(released);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not release this number.' });
    }
  });
}
