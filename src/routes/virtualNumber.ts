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
import { ensureRazorpayCustomer } from '../services/razorpayCustomer.service.js';
import { verifyRazorpaySubscriptionSignature } from '../utils/crypto.utils.js';
import type { SupportedCountryIso } from '../services/voiceProvider.types.js';
import {
  CALL_MARKUP_RATE,
  TERMINAL_OR_ACTIVE,
  callRateToInrPaise,
  findActiveById,
  findActiveNumbers,
  findLatest,
  lookupContactNames,
  otherPartyDigits,
  outboundPerMinInrPaise,
  resolveAddOnPricing,
  resolveCallRate,
  resolvePricing,
  resolveTax,
  withTax,
  providerFor,
  serialize,
  serializeNumber,
  toCallLogEntry,
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

/** Razorpay Plans are immutable and priced in advance — there's no "create a
 * subscription for this arbitrary amount" call, only "create a subscription against
 * an existing Plan". So one Plan is created lazily per exact (currency, amountMinor)
 * a checkout ever lands on, then reused for every later checkout at that same price —
 * see VirtualNumberRentalPlan's doc comment in schema.prisma. A later admin price
 * change (different commission/tax) simply lands on a different amountMinor and gets
 * its own new Plan; it never touches an already-created subscription's price. */
async function resolveRentalPlanId(razorpay: RazorpayService, amountMinor: number, currency: 'INR' | 'USD') {
  const existing = await prisma.virtualNumberRentalPlan.findUnique({
    where: { currency_amountMinor: { currency, amountMinor } },
  });
  if (existing) return existing.razorpayPlanId;

  const plan = await razorpay.createPlan({
    name: 'Virtual number rental',
    amountPaise: amountMinor,
    currency,
    period: 'monthly',
    description: 'ConvoSync virtual number — monthly rental',
  });

  // Two requests racing to price the same amount for the first time both create a
  // Razorpay plan (cheap, no charge) — whichever loses the unique-constraint race
  // just uses the winner's id instead of its own, so exactly one row survives.
  const row = await prisma.virtualNumberRentalPlan
    .create({ data: { currency, amountMinor, razorpayPlanId: plan.id } })
    .catch(async () => {
      const winner = await prisma.virtualNumberRentalPlan.findUnique({
        where: { currency_amountMinor: { currency, amountMinor } },
      });
      if (!winner) throw new Error('Could not resolve a rental plan for this price.');
      return winner;
    });
  return row.razorpayPlanId;
}

/** Buys the number from the provider and flips a `paid` request to `active` — the second
 * half of what `/pay/verify` used to do synchronously, now triggered explicitly by a
 * super-admin (see platform/virtual-number-requests.ts's /:id/allocate-number route) so a
 * workspace's payment doesn't immediately reach the carrier. Throws on purchase failure —
 * the caller is responsible for recording `purchaseError` on the row. */
export async function allocateNumberForPaidRequest(paid: VirtualNumberRow) {
  if (!paid.selectedNumber) {
    throw new Error('No number was selected for this request.');
  }

  const providerEnabled = paid.provider === 'telnyx' ? config.telnyx.enabled : config.plivo.enabled;
  const bought = providerEnabled
    ? await providerFor(paid).buyNumber(paid.selectedNumber, `workspace:${paid.workspaceId}`)
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

  return active;
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

      // Before a number is selected, selectedCountryIso is still null — fall back to the
      // workspace's own country so e.g. a Singapore workspace searches SG numbers instead
      // of whichever country each provider happens to default to internally. Also the key
      // resolvePricing() looks admin-configured pricing up by, for both branches below.
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { country: true } });
      const countryIso = (latest.selectedCountryIso ?? workspace?.country ?? undefined) as
        | SupportedCountryIso
        | undefined;

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
        const pricing = await resolvePricing(countryIso, 'fixed');
        const all = (mockByProvider[latest.provider] ?? mockByProvider.plivo).map((n) => ({
          ...n,
          type: 'fixed',
          priceInrPaise: pricing.currency === 'INR' ? pricing.monthlyPriceMinor : null,
          priceMinor: pricing.monthlyPriceMinor,
          currency: pricing.currency,
        }));
        return { source: 'mock', numbers: all, totalCount: all.length, hasMore: false };
      }

      try {
        const results = await providerFor(latest).searchAvailableNumbers({
          countryIso,
          pattern: query.pattern,
          offset: query.offset,
          limit: query.limit,
        });
        const numbers = await Promise.all(
          results.numbers.map(async (n) => {
            const pricing = await resolvePricing(countryIso, n.type);
            return {
              number: n.number,
              displayNumber: n.displayNumber,
              city: n.city ?? n.region,
              type: n.type,
              // Kept for old clients — only meaningful when currency is actually INR.
              // New clients should read priceMinor + currency instead.
              priceInrPaise: pricing.currency === 'INR' ? pricing.monthlyPriceMinor : null,
              priceMinor: pricing.monthlyPriceMinor,
              currency: pricing.currency,
            };
          }),
        );
        return {
          source: latest.provider,
          numbers,
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
          selectedCurrency: body.currency,
          selectedPriceMinor: body.priceMinor,
          // Kept populated only for INR — see the field's own doc comment in schema.prisma.
          selectedPriceInrPaise: body.currency === 'INR' ? body.priceMinor : null,
        },
      });
      return serialize(updated);
    },
  );

  /** The number's monthly rental is billed as a real recurring Razorpay Subscription
   * (not a one-time order) — the workspace is charged this exact amount every month
   * until the number is released (which cancels the subscription, see /:id/release). */
  app.post('/pay/create-subscription', { onRequest: companyAuthBilling.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest || latest.status !== 'number_selected' || !latest.selectedPriceMinor) {
      return reply.code(409).send({ error: 'Select a number before paying.' });
    }

    const currency = latest.selectedCurrency === 'USD' ? 'USD' : 'INR';
    const baseAmountMinor = latest.selectedPriceMinor;
    const tax = await resolveTax(latest.selectedCountryIso);
    const totalAmountMinor = withTax(baseAmountMinor, tax);

    try {
      const planId = await resolveRentalPlanId(razorpay, totalAmountMinor, currency);
      const customerId = await ensureRazorpayCustomer(workspaceId, razorpay);

      // 120 monthly cycles (10 years) — effectively "keep billing until cancelled",
      // matching the same total_count convention the SaaS plan subscriptions use
      // (see BillingService.createSubscription).
      const subscription = await razorpay.createSubscription({
        planId,
        totalCount: 120,
        customerNotify: true,
        notes: { workspaceId, virtualNumberRequestId: latest.id, purpose: 'virtual_number_rental' },
      });

      await prisma.virtualNumberRequest.update({
        where: { id: latest.id },
        data: {
          razorpaySubscriptionId: subscription.id,
          razorpayCustomerId: customerId,
          subscriptionStatus: subscription.status,
        },
      });

      return {
        subscriptionId: subscription.id,
        customerId,
        amountMinor: totalAmountMinor,
        baseAmountMinor,
        taxMinor: totalAmountMinor - baseAmountMinor,
        taxLabel: tax.taxLabel,
        taxRatePercent: tax.taxRatePercent,
        currency,
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
      if (!latest || latest.razorpaySubscriptionId !== body.razorpay_subscription_id) {
        return reply.code(404).send({ error: 'No matching subscription for this workspace.' });
      }
      if (latest.status === 'active') return serialize(latest); // already settled — idempotent

      const validSignature = verifyRazorpaySubscriptionSignature(
        body.razorpay_payment_id,
        body.razorpay_subscription_id,
        body.razorpay_signature,
        config.razorpay.keySecret,
      );
      if (!validSignature) return reply.code(400).send({ error: 'Invalid payment signature.' });

      // The number is NOT bought from the provider here — payment only reaches `paid`.
      // A super-admin reviews and triggers the actual purchase from the platform's
      // virtual-number-requests panel (POST /platform/virtual-number-requests/:id/allocate-number,
      // which calls allocateNumberForPaidRequest below). This is a deliberate manual gate,
      // not a bug: real money has moved, but the carrier number isn't provisioned until an
      // admin allocates one.
      const paid = await prisma.virtualNumberRequest.update({
        where: { id: latest.id },
        data: {
          status: 'paid',
          razorpayPaymentId: body.razorpay_payment_id,
          paidAt: new Date(),
          // Add-ons the workspace opted into on the checkout page — preference only for
          // now, see the fields' doc comments in schema.prisma. Persisted now (rather than
          // at allocation time) since allocation is a separate admin action later.
          transcriptionEnabled: body.transcriptionEnabled ?? false,
          recordingStorageEnabled: body.recordingStorageEnabled ?? false,
        },
      });

      if (!paid.selectedNumber) {
        return reply.code(500).send({ error: 'Payment recorded but no number was selected.' });
      }

      return serialize(paid);
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

    const adminRate = await resolveCallRate(row.selectedCountryIso);
    if (adminRate) {
      return {
        countryIso: row.selectedCountryIso,
        countryName: adminRate.countryName,
        outboundPerMinInrPaise: callRateToInrPaise(adminRate),
        markupRate: adminRate.commissionPercent / 100,
        source: 'admin',
      };
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

  /** Recording/transcription reference rates for this workspace's number provider —
   * informational only (usage-based, not part of the upfront checkout charge). Keyed
   * off the workspace's current request rather than an active number so the checkout
   * page can show these before the number is even purchased. */
  app.get('/addon-pricing', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest) return reply.code(404).send({ error: 'No virtual number request found.' });

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { country: true } });
    const countryIso = latest.selectedCountryIso ?? workspace?.country ?? 'IN';

    const [recording, transcription, storage] = await Promise.all([
      resolveAddOnPricing(countryIso, 'recording'),
      resolveAddOnPricing(countryIso, 'transcription'),
      resolveAddOnPricing(countryIso, 'storage'),
    ]);
    return { provider: latest.provider, recording, transcription, storage };
  });

  /** Tax rate for the checkout preview (before /pay/create-order actually charges it) —
   * same country resolution as /available-numbers, so the number shown here always
   * matches what create-order will apply. */
  app.get('/tax-info', { onRequest: companyAuth.onRequest }, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    if (!workspaceId) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await findLatest(workspaceId);
    if (!latest) return reply.code(404).send({ error: 'No virtual number request found.' });

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { country: true } });
    const countryIso = latest.selectedCountryIso ?? workspace?.country ?? undefined;
    const tax = await resolveTax(countryIso);
    return { countryIso: countryIso ?? null, ...tax };
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
          ...(body.transcriptionEnabled !== undefined && { transcriptionEnabled: body.transcriptionEnabled }),
          ...(body.recordingStorageEnabled !== undefined && {
            recordingStorageEnabled: body.recordingStorageEnabled,
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
      // The monthly rental is a real recurring subscription — cancel it or the
      // workspace keeps being charged every month for a number they no longer have.
      // Best-effort: a Razorpay hiccup here shouldn't block the release itself (the
      // number is already gone from the provider), but it must not be silent —
      // support needs to know if a subscription is still live for a released number.
      if (row.razorpaySubscriptionId) {
        try {
          await razorpay.cancelSubscription(row.razorpaySubscriptionId);
        } catch (err) {
          console.error('[virtual-number/release] Failed to cancel Razorpay subscription', {
            requestId: row.id,
            razorpaySubscriptionId: row.razorpaySubscriptionId,
            err,
          });
        }
      }

      const released = await prisma.virtualNumberRequest.update({
        where: { id: row.id },
        data: { status: 'released', releasedAt: new Date(), subscriptionStatus: 'cancelled' },
      });
      return serialize(released);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Could not release this number.' });
    }
  });
}
