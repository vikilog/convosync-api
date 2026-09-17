import { prisma } from '../lib/prisma.js';
import { resolveVoiceProvider } from '../config.js';
import { whatsappCanonicalDigits } from '../lib/whatsappContact.js';
import { plivoProvider } from '../services/plivo.service.js';
import { telnyxProvider } from '../services/telnyx.service.js';
import type { CallRecord, SupportedCountryIso, VoiceProvider } from '../services/voiceProvider.types.js';

/**
 * Shared, provider-agnostic pieces of the virtual-number feature — split out of
 * virtualNumber.ts (which was already ~1000 lines before Telnyx existed) so the
 * routes file, and each provider's webhook file, can import just what they need.
 */

export const TERMINAL_OR_ACTIVE = new Set(['rejected', 'active']);

/** Flat per-type base pricing (pre-tax) — kept on our side rather than trusting
 * a provider's returned rental rate, which isn't guaranteed to be in INR. Used
 * as the fallback inside resolvePricing() when no admin price is configured. */
export function priceForType(type: string): number {
  return type === 'tollfree' || type === 'toll_free' ? 750_00 : 300_00;
}

/** Countries the number picker offers today (see resolveVoiceProvider/TELNYX_COUNTRIES
 * in config.ts) — the choices offered in the admin pricing form's country selector. */
export const SUPPORTED_PRICING_COUNTRIES: Array<{ iso: string; name: string; defaultCurrency: string }> = [
  { iso: 'IN', name: 'India', defaultCurrency: 'INR' },
  { iso: 'US', name: 'United States', defaultCurrency: 'USD' },
  { iso: 'GB', name: 'United Kingdom', defaultCurrency: 'GBP' },
  { iso: 'SG', name: 'Singapore', defaultCurrency: 'SGD' },
];

function normalizeNumberType(type: string): 'local' | 'tollfree' {
  return type === 'tollfree' || type === 'toll_free' ? 'tollfree' : 'local';
}

/** `monthlyPriceMinor` here is the FINAL price a workspace pays (base cost + platform
 * commission already applied) — every existing call site can keep treating it as "the
 * price to charge," unchanged. `baseCostMinor`/`commissionPercent` are the breakdown,
 * for admin-facing display only. */
export type ResolvedPricing = {
  monthlyPriceMinor: number;
  currency: string;
  baseCostMinor: number;
  commissionPercent: number;
};

/** Admin-configured price for a country + number-type (VirtualNumberPricing), falling
 * back to the flat priceForType() INR pricing when nothing has been configured for
 * that country yet — so an unconfigured country behaves exactly as before. */
export async function resolvePricing(
  countryIso: string | undefined,
  type: string,
): Promise<ResolvedPricing> {
  const numberType = normalizeNumberType(type);
  if (countryIso) {
    const row = await prisma.virtualNumberPricing.findUnique({
      where: { countryIso_numberType: { countryIso, numberType } },
    });
    if (row) {
      const finalMinor = Math.round(row.monthlyPriceMinor * (1 + row.commissionPercent / 100));
      return {
        monthlyPriceMinor: finalMinor,
        currency: row.currency,
        baseCostMinor: row.monthlyPriceMinor,
        commissionPercent: row.commissionPercent,
      };
    }
  }
  const fallbackMinor = priceForType(type);
  return { monthlyPriceMinor: fallbackMinor, currency: 'INR', baseCostMinor: fallbackMinor, commissionPercent: 0 };
}

export type AddOnType = 'recording' | 'transcription' | 'storage';

/** Rates as of the research behind this feature — NOT fetched live, because neither
 * provider's account Pricing API returns recording/transcription/storage rates (only
 * voice in/outbound). Plivo's are the real account rates (cx.plivo.com/billing/
 * plans-and-pricing, India region, Professional plan, checked 2026-09-17) — billed in
 * INR, not converted. Telnyx's are published USD list prices (telnyx.com/pricing/
 * voice-api, telnyx.com/pricing/speech-to-text) — Telnyx doesn't publish a separate
 * storage line, so that combination is "not offered" rather than a guess. */
const ADDON_FALLBACK_RATES: Record<string, { currency: string; ratePerMinMinor: number } | null> = {
  'plivo:recording': { currency: 'INR', ratePerMinMinor: 0 }, // Included free
  'plivo:transcription': { currency: 'INR', ratePerMinMinor: 76 }, // ₹0.76/min
  'plivo:storage': { currency: 'INR', ratePerMinMinor: 3.2 }, // ₹0.032/min/month, free first 90 days
  'telnyx:recording': { currency: 'USD', ratePerMinMinor: 0.2 }, // $0.002/min
  'telnyx:transcription': { currency: 'USD', ratePerMinMinor: 1.5 }, // $0.015/min
  'telnyx:storage': null,
};

export type ResolvedAddOnRate = { addOnType: AddOnType; currency: string; ratePerMinMinor: number } | null;

/** Admin-configured add-on rate for this country, falling back to the provider's
 * published rate above when nothing has been set for that country yet (and to `null`
 * — "not offered" — for Plivo transcription, since no published rate exists to fall
 * back to). Provider is derived from countryIso, same rule used to route the call itself. */
export async function resolveAddOnPricing(
  countryIso: string,
  addOnType: AddOnType,
): Promise<ResolvedAddOnRate> {
  const provider = resolveVoiceProvider(countryIso);
  const row = await prisma.virtualNumberAddOnPricing.findUnique({
    where: { countryIso_addOnType: { countryIso, addOnType } },
  });
  if (row) return { addOnType, currency: row.currency, ratePerMinMinor: row.ratePerMinMinor };

  const fallback = ADDON_FALLBACK_RATES[`${provider}:${addOnType}`];
  return fallback ? { addOnType, currency: fallback.currency, ratePerMinMinor: fallback.ratePerMinMinor } : null;
}

export const GST_RATE = 0.18;

/** Base price → amount actually charged (base + 18% GST), rounded to the paisa.
 * Applied unconditionally regardless of provider/country — see plan's Billing decision. */
export function withGst(baseInrPaise: number): number {
  return Math.round(baseInrPaise * (1 + GST_RATE));
}

export type ResolvedTax = { taxLabel: string; taxRatePercent: number };

/** Admin-configured tax rate for a country, falling back to exactly today's hardcoded
 * rule when nothing has been set: 18% "GST" for India, 0% everywhere else — so an
 * unconfigured country behaves identically to before this table existed. */
export async function resolveTax(countryIso: string | undefined | null): Promise<ResolvedTax> {
  if (countryIso) {
    const row = await prisma.virtualNumberCountryTax.findUnique({ where: { countryIso } });
    if (row) return { taxLabel: row.taxLabel, taxRatePercent: row.taxRatePercent };
  }
  return countryIso === 'IN' || !countryIso
    ? { taxLabel: 'GST', taxRatePercent: GST_RATE * 100 }
    : { taxLabel: 'Tax', taxRatePercent: 0 };
}

/** Base amount → amount actually charged, applying a resolved tax rate. */
export function withTax(baseMinor: number, tax: ResolvedTax): number {
  return Math.round(baseMinor * (1 + tax.taxRatePercent / 100));
}

/** Same fallback USD→INR rate used elsewhere for display-only conversions (workspaceTokenUsage.ts). */
export const USD_TO_INR = 85;
export const CALL_MARKUP_RATE = 0.1;

export function outboundPerMinInrPaise(usdPerMin: number): number {
  const usd = Number.isFinite(usdPerMin) && usdPerMin > 0 ? usdPerMin : 0;
  return Math.round(Math.round(usd * USD_TO_INR * 100) * (1 + CALL_MARKUP_RATE));
}

export type ResolvedCallRate = {
  countryName: string;
  currency: string;
  ratePerMinMinor: number;
  baseCostPerMinMinor: number;
  commissionPercent: number;
};

/** Admin-configured per-minute outbound call rate for a country (VirtualNumberCallPricing),
 * or `null` when nothing has been set — the caller falls back to the existing live
 * provider pricing-API call in that case, so an unconfigured country behaves exactly
 * as before this table existed. */
export async function resolveCallRate(countryIso: string | undefined | null): Promise<ResolvedCallRate | null> {
  if (!countryIso) return null;
  const row = await prisma.virtualNumberCallPricing.findUnique({ where: { countryIso } });
  if (!row) return null;
  const ratePerMinMinor = row.baseCostPerMinMinor * (1 + row.commissionPercent / 100);
  return {
    countryName: row.countryName,
    currency: row.currency,
    ratePerMinMinor,
    baseCostPerMinMinor: row.baseCostPerMinMinor,
    commissionPercent: row.commissionPercent,
  };
}

/** The admin-configured call rate is stored in whatever currency the country's cost
 * naturally comes in (INR for India, USD/GBP/SGD elsewhere), but the wallet — and this
 * feature's whole existing contract (`outboundPerMinInrPaise`) — is INR-only. INR rows
 * pass through as-is; anything else reuses the same USD_TO_INR conversion the live-fetch
 * path already applies (a known simplification — GBP/SGD aren't USD, see the three-way
 * FX-rate inconsistency noted elsewhere in this codebase — not fixed here). */
export function callRateToInrPaise(rate: ResolvedCallRate): number {
  if (rate.currency === 'INR') return Math.round(rate.ratePerMinMinor);
  return Math.round((rate.ratePerMinMinor / 100) * USD_TO_INR * 100);
}

/** Answered / no-answer / busy / failed, derived from call_state + hangup cause —
 * works for either provider since both normalize into the same CallRecord shape. */
export function statusFromCallRecord(record: CallRecord): 'answered' | 'no-answer' | 'busy' | 'failed' {
  if (record.callState === 'ANSWER' || record.callState.toLowerCase() === 'answered') return 'answered';
  const cause = (record.hangupCause ?? '').toLowerCase();
  if (cause.includes('busy')) return 'busy';
  if (cause.includes('no answer') || cause.includes('unanswered') || cause.includes('no_answer')) return 'no-answer';
  return 'failed';
}

export function otherPartyDigits(record: CallRecord, ourNumber: string): string {
  const ourDigits = ourNumber.replace(/\D/g, '');
  const otherParty = record.from.replace(/\D/g, '').includes(ourDigits) ? record.to : record.from;
  return otherParty.replace(/\D/g, '');
}

export type ContactRef = { id: string; name: string };

export function toCallLogEntry(
  record: CallRecord,
  ourNumber: string,
  formatDisplayNumber: (raw: string) => string,
  hasRecording: boolean,
  contact: ContactRef | null = null,
) {
  const ourDigits = ourNumber.replace(/\D/g, '');
  const otherParty = record.from.replace(/\D/g, '').includes(ourDigits) ? record.to : record.from;
  return {
    id: record.callUuid,
    direction: record.direction,
    status: statusFromCallRecord(record),
    contact: {
      phone: formatDisplayNumber(otherParty),
      rawPhone: otherParty,
      name: contact?.name ?? null,
      contactId: contact?.id ?? null,
    },
    fromNumber: formatDisplayNumber(ourNumber),
    startedAt: record.startTime,
    durationSeconds: record.durationSeconds,
    hasRecording,
  };
}

/** Matches raw call-log numbers against the workspace's contact book (same +91/local
 * collapse rules as WhatsApp contact dedupe) so calls from a known contact show their
 * name (and link to their contact page) instead of just the bare number. Returns a map
 * keyed by the raw digits passed in. */
export async function lookupContactNames(
  workspaceId: string,
  rawDigitsList: string[],
): Promise<Map<string, ContactRef>> {
  const canonicalByRaw = new Map<string, string>();
  const canonicalSet = new Set<string>();
  for (const digits of rawDigitsList) {
    const canonical = whatsappCanonicalDigits(digits);
    if (!canonical) continue;
    canonicalByRaw.set(digits, canonical);
    canonicalSet.add(canonical);
  }
  if (canonicalSet.size === 0) return new Map();

  const orClauses = Array.from(canonicalSet).flatMap((c) => [
    { phone: c },
    { phone: `+${c}` },
    { phone: `91${c}` },
    { phone: `+91${c}` },
  ]);

  const contacts = await prisma.contact.findMany({
    where: { workspaceId, OR: orClauses },
    select: { id: true, name: true, phone: true },
  });

  const byCanonical = new Map<string, ContactRef>();
  for (const c of contacts) {
    const key = whatsappCanonicalDigits(c.phone);
    if (key && !byCanonical.has(key)) byCanonical.set(key, { id: c.id, name: c.name });
  }

  const result = new Map<string, ContactRef>();
  for (const [raw, canonical] of canonicalByRaw) {
    const ref = byCanonical.get(canonical);
    if (ref) result.set(raw, ref);
  }
  return result;
}

export function findLatest(workspaceId: string) {
  return prisma.virtualNumberRequest.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
}

export type VirtualNumberRow = NonNullable<Awaited<ReturnType<typeof findLatest>>>;

/** Picks the right VoiceProvider adapter for a request row. `provider` is a plain
 * string column (not a Prisma enum) — anything unrecognized safely falls back to Plivo. */
export function providerFor(row: Pick<VirtualNumberRow, 'provider'>): VoiceProvider {
  return row.provider === 'telnyx' ? telnyxProvider : plivoProvider;
}

export function serialize(row: VirtualNumberRow) {
  return {
    id: row.id,
    stage: row.status,
    label: row.label,
    provider: row.provider,
    requestedAt: row.requestedAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    selectedNumber: row.selectedNumber
      ? {
          // Raw provider digits — the frontend matches this against the search
          // results' `.number` field to highlight the selected card.
          number: row.selectedNumber,
          city: row.selectedCity,
          priceInrPaise: row.selectedPriceInrPaise,
          priceMinor: row.selectedPriceMinor,
          currency: row.selectedCurrency,
        }
      : null,
    razorpayOrderId: row.razorpayOrderId,
    paidAt: row.paidAt?.toISOString() ?? null,
    activeNumber:
      row.status === 'active' && row.selectedNumber
        ? {
            number: providerFor(row).formatDisplayNumber(row.selectedNumber, (row.selectedCountryIso ?? undefined) as SupportedCountryIso | undefined),
            city: row.selectedCity,
            plivoNumberId: row.plivoNumberId,
          }
        : null,
    purchaseError: row.purchaseError,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    missedCallAutoReplyEnabled: row.missedCallAutoReplyEnabled,
    missedCallMessage: row.missedCallMessage,
    missedCallTemplateId: row.missedCallTemplateId,
    userMissedCallAutoReplyEnabled: row.userMissedCallAutoReplyEnabled,
    userMissedCallMessage: row.userMissedCallMessage,
    userMissedCallTemplateId: row.userMissedCallTemplateId,
  };
}

/** One entry in the workspace's number list — every `active` row, each independently manageable. */
export function serializeNumber(row: VirtualNumberRow) {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    provider: row.provider,
    number: row.selectedNumber ? providerFor(row).formatDisplayNumber(row.selectedNumber, (row.selectedCountryIso ?? undefined) as SupportedCountryIso | undefined) : null,
    rawNumber: row.selectedNumber,
    city: row.selectedCity,
    plivoNumberId: row.plivoNumberId,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    missedCallAutoReplyEnabled: row.missedCallAutoReplyEnabled,
    missedCallMessage: row.missedCallMessage,
    missedCallTemplateId: row.missedCallTemplateId,
    userMissedCallAutoReplyEnabled: row.userMissedCallAutoReplyEnabled,
    userMissedCallMessage: row.userMissedCallMessage,
    userMissedCallTemplateId: row.userMissedCallTemplateId,
    transcriptionEnabled: row.transcriptionEnabled,
    recordingStorageEnabled: row.recordingStorageEnabled,
  };
}

export function findActiveNumbers(workspaceId: string) {
  return prisma.virtualNumberRequest.findMany({
    where: { workspaceId, status: 'active' },
    orderBy: { activatedAt: 'asc' },
  });
}

export function findActiveById(workspaceId: string, id: string) {
  return prisma.virtualNumberRequest.findFirst({ where: { id, workspaceId, status: 'active' } });
}

/** Keeps a number's subscription bookkeeping (status, current period) in sync with
 * Razorpay's own subscription lifecycle — called from the shared Razorpay webhook
 * handler (webhook.controller.ts) alongside the SaaS-plan handler; no-ops if the
 * subscription id doesn't belong to a virtual number (i.e. it's a SaaS-plan sub). */
export async function handleVirtualNumberSubscriptionEvent(
  event: string,
  sub: { id: string; status?: string; current_end?: number },
) {
  const row = await prisma.virtualNumberRequest.findFirst({ where: { razorpaySubscriptionId: sub.id } });
  if (!row) return;

  await prisma.virtualNumberRequest.update({
    where: { id: row.id },
    data: {
      subscriptionStatus: sub.status ?? row.subscriptionStatus,
      currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : row.currentPeriodEnd,
    },
  });

  if (event === 'subscription.halted') {
    console.error('[virtualNumber] Subscription halted — renewal is failing', {
      requestId: row.id,
      workspaceId: row.workspaceId,
      razorpaySubscriptionId: sub.id,
    });
  }
}

/** `subscription.charged` — a monthly renewal actually collected payment. Just
 * refreshes the tracked period end; there's no per-cycle invoice record for virtual
 * numbers today (unlike BillingInvoice for SaaS plans) — add one if that's ever needed. */
export async function handleVirtualNumberSubscriptionCharged(sub: { id: string; current_end?: number }) {
  const row = await prisma.virtualNumberRequest.findFirst({ where: { razorpaySubscriptionId: sub.id } });
  if (!row) return;

  await prisma.virtualNumberRequest.update({
    where: { id: row.id },
    data: {
      subscriptionStatus: 'active',
      currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : row.currentPeriodEnd,
    },
  });
}
