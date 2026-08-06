/**
 * Normalize Meta WhatsApp status-webhook `errors[]` for permanent DB storage
 * on message.metadata (merged — never wipes templateId/variables).
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

/** Merge Meta delivery failure into existing message.metadata. Returns null when nothing to persist. */
export function mergeWhatsAppStatusMetadata(
  existing: unknown,
  statusUpdate: Pick<WhatsAppStatusUpdate, 'status' | 'timestamp' | 'recipient_id' | 'errors'>
): Record<string, unknown> | null {
  const errors = normalizeWhatsAppStatusErrors(statusUpdate.errors);
  if (statusUpdate.status !== 'failed' && errors.length === 0) return null;

  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  if (errors.length) base.whatsappStatusErrors = errors;
  base.whatsappDeliveryStatus = {
    status: statusUpdate.status,
    timestamp: statusUpdate.timestamp ?? null,
    recipientId: statusUpdate.recipient_id ?? null,
  };
  return base;
}
