/**
 * Pure campaign analytics helpers (funnel, success, lag, failure reasons).
 */

export type StatusEvent = { type: string; at: string; detail?: string };

export type LagBucket = { label: string; count: number; minMs: number; maxMs: number | null };

export type LagSeries = {
  samples: number;
  medianMs: number | null;
  buckets: LagBucket[];
};

const LAG_BUCKET_DEFS: Array<{ label: string; minMs: number; maxMs: number | null }> = [
  { label: '<1m', minMs: 0, maxMs: 60_000 },
  { label: '1–5m', minMs: 60_000, maxMs: 5 * 60_000 },
  { label: '5–15m', minMs: 5 * 60_000, maxMs: 15 * 60_000 },
  { label: '15–60m', minMs: 15 * 60_000, maxMs: 60 * 60_000 },
  { label: '1–6h', minMs: 60 * 60_000, maxMs: 6 * 60 * 60_000 },
  { label: '6h+', minMs: 6 * 60 * 60_000, maxMs: null },
];

export function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function medianMs(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function bucketLag(valuesMs: number[]): LagSeries {
  const buckets: LagBucket[] = LAG_BUCKET_DEFS.map((d) => ({ ...d, count: 0 }));
  for (const ms of valuesMs) {
    if (!Number.isFinite(ms) || ms < 0) continue;
    const idx = buckets.findIndex((b) => ms >= b.minMs && (b.maxMs == null || ms < b.maxMs));
    if (idx >= 0) buckets[idx]!.count += 1;
  }
  return { samples: valuesMs.length, medianMs: medianMs(valuesMs), buckets };
}

export function parseEvents(metadata: unknown): StatusEvent[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>).events;
  if (!Array.isArray(raw)) return [];
  const out: StatusEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.type !== 'string' || !e.type) continue;
    if (typeof e.at !== 'string' || !e.at) continue;
    out.push({
      type: e.type.toLowerCase(),
      at: e.at,
      ...(typeof e.detail === 'string' && e.detail ? { detail: e.detail } : {}),
    });
  }
  return out;
}

function eventTimeMs(events: StatusEvent[], types: string[]): number | null {
  const want = new Set(types.map((t) => t.toLowerCase()));
  for (const e of events) {
    if (!want.has(e.type)) continue;
    const t = Date.parse(e.at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** First matching event ISO timestamp (webhook timeline), or null. */
export function firstEventAt(events: StatusEvent[], types: string[]): string | null {
  const ms = eventTimeMs(events, types);
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Cumulative delivered count vs time from per-recipient deliveredAt ISOs.
 * Skips null/invalid; sorts ascending; one point per delivery.
 */
export function buildCumulativeDeliverySeries(
  deliveredAts: Array<string | null | undefined>
): Array<{ at: string; cumulative: number }> {
  const times = deliveredAts
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  return times.map((ms, i) => ({
    at: new Date(ms).toISOString(),
    cumulative: i + 1,
  }));
}

/**
 * First dispatch time for a recipient: earliest `sent` event only (ignores `resent`
 * so a later manual retry cannot inflate completion time). Falls back to message
 * createdAt (`sentAtMs`) once status shows the row left the pending queue.
 */
export function firstSentMs(row: {
  status: string;
  sentAtMs: number;
  events: StatusEvent[];
}): number | null {
  const fromEvents = eventTimeMs(row.events, ['sent']);
  if (fromEvents != null) return fromEvents;
  const s = row.status.toLowerCase();
  // Still queued — no dispatch yet
  if (s === 'pending' || s === 'queued') return null;
  if (Number.isFinite(row.sentAtMs)) return row.sentAtMs;
  return null;
}

export function extractLagSamples(
  rows: Array<{ status: string; sentAtMs: number; events: StatusEvent[] }>,
  opts: { readTypes: string[] }
): { sendToDelivered: number[]; deliveredToRead: number[]; lagAvailable: boolean } {
  const sendToDelivered: number[] = [];
  const deliveredToRead: number[] = [];

  for (const row of rows) {
    const sentMs =
      eventTimeMs(row.events, ['sent', 'resent']) ??
      (Number.isFinite(row.sentAtMs) ? row.sentAtMs : null);
    const deliveredMs = eventTimeMs(row.events, ['delivered']);
    const readMs = eventTimeMs(row.events, opts.readTypes);

    if (sentMs != null && deliveredMs != null && deliveredMs >= sentMs) {
      sendToDelivered.push(deliveredMs - sentMs);
    }
    if (deliveredMs != null && readMs != null && readMs >= deliveredMs) {
      deliveredToRead.push(readMs - deliveredMs);
    } else if (sentMs != null && readMs != null && deliveredMs == null && readMs >= sentMs) {
      // read implies delivered; attribute full lag to send→read via delivered=sent midpoint skip —
      // ponytail: without delivered event, skip delivered→read (can't split)
    }
  }

  return {
    sendToDelivered,
    deliveredToRead,
    lagAvailable: sendToDelivered.length > 0 || deliveredToRead.length > 0,
  };
}

export function formatDurationMs(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / (60 * 60_000));
  const m = Math.round((ms % (60 * 60_000)) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export type FunnelStep = { key: string; label: string; count: number; pct: number };

export function buildFunnel(input: {
  channel: 'whatsapp' | 'email' | 'instagram';
  totalRecipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}): FunnelStep[] {
  const denom = input.totalRecipients > 0 ? input.totalRecipients : input.sent;
  const readLabel = input.channel === 'email' ? 'Opened' : 'Read';
  return [
    { key: 'sent', label: 'Sent', count: input.sent, pct: rate(input.sent, denom) },
    { key: 'delivered', label: 'Delivered', count: input.delivered, pct: rate(input.delivered, denom) },
    { key: 'read', label: readLabel, count: input.read, pct: rate(input.read, denom) },
    { key: 'failed', label: 'Failed', count: input.failed, pct: rate(input.failed, denom) },
  ];
}

/**
 * Real success vs audience size: delivered-or-better over total recipients,
 * so failures / never-sent pull the rate down (unlike delivered/sent).
 */
export function successRate(deliveredOrBetter: number, totalRecipients: number, failed: number): number {
  if (totalRecipients <= 0) {
    const denom = deliveredOrBetter + failed;
    return rate(deliveredOrBetter, denom);
  }
  return rate(deliveredOrBetter, totalRecipients);
}

export function aggregateFailureReasons(
  reasons: Array<string | null | undefined>
): Array<{ reason: string; count: number; pct: number }> {
  const map = new Map<string, number>();
  let total = 0;
  for (const raw of reasons) {
    if (!raw || !raw.trim()) continue;
    const reason = raw.trim().slice(0, 160);
    map.set(reason, (map.get(reason) ?? 0) + 1);
    total += 1;
  }
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count, pct: rate(count, total) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

/**
 * Dispatch duration through the recipient list — not post-send delivery/read lag.
 * Start: caller supplies scheduledAt (fallback sentAt → createdAt).
 * End: max(first `sent` per recipient). Pending until every recipient has a first send.
 */
export function completionTiming(input: {
  startedAt: Date | null;
  recipients: Array<{ status: string; sentAtMs: number; events: StatusEvent[] }>;
}): { startedAt: string | null; completedAt: string | null; durationMs: number | null; durationLabel: string | null } {
  const startedAt = input.startedAt;
  if (!startedAt || input.recipients.length === 0) {
    return {
      startedAt: startedAt?.toISOString() ?? null,
      completedAt: null,
      durationMs: null,
      durationLabel: null,
    };
  }

  let endMs: number | null = null;
  for (const r of input.recipients) {
    const sentMs = firstSentMs(r);
    // Any recipient still without a first send → campaign dispatch incomplete
    if (sentMs == null) {
      return {
        startedAt: startedAt.toISOString(),
        completedAt: null,
        durationMs: null,
        durationLabel: null,
      };
    }
    if (endMs == null || sentMs > endMs) endMs = sentMs;
  }

  if (endMs == null) {
    return {
      startedAt: startedAt.toISOString(),
      completedAt: null,
      durationMs: null,
      durationLabel: null,
    };
  }

  const durationMs = Math.max(0, endMs - startedAt.getTime());
  return {
    startedAt: startedAt.toISOString(),
    completedAt: new Date(endMs).toISOString(),
    durationMs,
    durationLabel: formatDurationMs(durationMs),
  };
}
