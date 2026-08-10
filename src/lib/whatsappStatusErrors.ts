/**
 * Normalize Meta WhatsApp status-webhook `errors[]` for permanent DB storage
 * on message.metadata (merged — never wipes templateId/variables).
 * Also appends metadata.events[] timeline (sent/delivered/read/failed) with timestamps.
 */

export type WhatsAppStatusError = {
  code?: number;
  title?: string;
  message?: string;
  href?: string;
  error_data?: { details?: string };
};

export type WhatsAppStatusUpdate = {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: unknown;
};

export function normalizeWhatsAppStatusErrors(raw: unknown): WhatsAppStatusError[] {
  if (!Array.isArray(raw)) return [];
  const out: WhatsAppStatusError[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    const next: WhatsAppStatusError = {};
    if (typeof e.code === 'number') next.code = e.code;
    if (typeof e.title === 'string' && e.title) next.title = e.title;
    if (typeof e.message === 'string' && e.message) next.message = e.message;
    if (typeof e.href === 'string' && e.href) next.href = e.href;
    if (e.error_data && typeof e.error_data === 'object' && !Array.isArray(e.error_data)) {
      const details = (e.error_data as Record<string, unknown>).details;
      if (typeof details === 'string' && details) next.error_data = { details };
    }
    if (next.code != null || next.title || next.message) out.push(next);
  }
  return out;
}

/** Meta status.timestamp is unix seconds (string); accept ms too. */
export function whatsappStatusTimestampToIso(timestamp?: string | null): string {
  if (timestamp == null || timestamp === '') return new Date().toISOString();
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return new Date().toISOString();
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

/**
 * Merge Meta delivery status into existing message.metadata.
 * Always appends events[] for analytics lag charts; preserves campaignId/template fields.
 */
export function mergeWhatsAppStatusMetadata(
  existing: unknown,
  statusUpdate: Pick<WhatsAppStatusUpdate, 'status' | 'timestamp' | 'recipient_id' | 'errors'>
): Record<string, unknown> {
  const errors = normalizeWhatsAppStatusErrors(statusUpdate.errors);
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const status = (statusUpdate.status || '').toLowerCase();
  const at = whatsappStatusTimestampToIso(statusUpdate.timestamp);
  const prevEvents = Array.isArray(base.events) ? [...base.events] : [];
  const event: Record<string, unknown> = { type: status || 'unknown', at };
  if (errors[0]) {
    const detail = errors[0].title || errors[0].message;
    if (detail) event.detail = detail;
  }
  prevEvents.push(event);
  // ponytail: cap at 40 — WA statuses are few; resend storms are the ceiling
  base.events = prevEvents.length > 40 ? prevEvents.slice(-40) : prevEvents;

  if (errors.length) base.whatsappStatusErrors = errors;
  if (status === 'failed' || errors.length > 0) {
    base.whatsappDeliveryStatus = {
      status: statusUpdate.status,
      timestamp: statusUpdate.timestamp ?? null,
      recipientId: statusUpdate.recipient_id ?? null,
    };
  }

  return base;
}
