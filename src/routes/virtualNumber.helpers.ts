import { prisma } from '../lib/prisma.js';
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
 * a provider's returned rental rate, which isn't guaranteed to be in INR. */
export function priceForType(type: string): number {
  return type === 'tollfree' || type === 'toll_free' ? 750_00 : 300_00;
}

export const GST_RATE = 0.18;

/** Base price → amount actually charged (base + 18% GST), rounded to the paisa.
 * Applied unconditionally regardless of provider/country — see plan's Billing decision. */
export function withGst(baseInrPaise: number): number {
  return Math.round(baseInrPaise * (1 + GST_RATE));
}

/** Same fallback USD→INR rate used elsewhere for display-only conversions (workspaceTokenUsage.ts). */
export const USD_TO_INR = 85;
export const CALL_MARKUP_RATE = 0.1;

export function outboundPerMinInrPaise(usdPerMin: number): number {
  const usd = Number.isFinite(usdPerMin) && usdPerMin > 0 ? usdPerMin : 0;
  return Math.round(Math.round(usd * USD_TO_INR * 100) * (1 + CALL_MARKUP_RATE));
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
