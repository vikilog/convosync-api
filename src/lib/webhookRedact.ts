const PII_KEYS = new Set([
  'text',
  'body',
  'caption',
  'wa_id',
  'from',
  'to',
  'name',
  'email',
  'phone',
  'display_phone_number',
  'profile',
  'contacts',
  'token',
  'recipient_id',
  'identity',
  'fallback',
  'code',
  'password',
]);

export function redactWebhookPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactWebhookPayload);
  if (payload && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      out[k] = PII_KEYS.has(k.toLowerCase()) ? '[redacted]' : redactWebhookPayload(v);
    }
    return out;
  }
  return payload;
}
