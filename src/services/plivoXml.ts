/**
 * Plivo Voice XML helpers. Dial's only legal children are Number and User —
 * `<Client>` is Twilio XML and Plivo rejects it as hangup 8011 (Invalid Answer XML).
 * https://www.plivo.com/docs/voice/xml/overview (nesting: Dial → Number, User)
 */

export const PLIVO_SIP_DOMAIN = 'phone.plivo.com';

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SIP URI Plivo expects inside `<User>` when ringing a Browser SDK endpoint. */
export function sipUriForEndpoint(username: string): string {
  const trimmed = username.trim();
  if (/^sip:/i.test(trimmed)) return trimmed;
  return `sip:${trimmed}@${PLIVO_SIP_DOMAIN}`;
}

/** Username from a From/To SIP URI like `sip:csfoo1234@phone.plivo.com`. */
export function endpointUsernameFromSip(from: string): string | null {
  const trimmed = from.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^sip:/i, '');
  const user = withoutScheme.split('@')[0]?.split(';')[0]?.trim();
  return user || null;
}

export function isPlivoEndpointSip(from: string): boolean {
  return /@phone\.plivo\.com/i.test(from) || /^sip:/i.test(from);
}

/** X-PH-callerid (and casing/underscore variants) that the Browser SDK sends on outbound. */
export function extraHeaderCallerId(body: Record<string, string>): string {
  for (const [key, value] of Object.entries(body)) {
    if (key.toLowerCase().replace(/_/g, '-').includes('callerid')) {
      const digits = String(value).replace(/\D/g, '');
      if (digits) return digits;
    }
  }
  return '';
}

/**
 * Plivo sets Direction=inbound even when the Browser SDK originates a call
 * (the INVITE hits Plivo first). Real PSTN inbound is To = one of our numbers;
 * browser outbound To = the dest and From = our SIP endpoint.
 */
export function isPstnInboundToOwnedNumber(to: string, ownedDigits: Iterable<string>): boolean {
  const toDigits = to.replace(/\D/g, '');
  if (!toDigits) return false;
  for (const n of ownedDigits) {
    if (n.replace(/\D/g, '') === toDigits) return true;
  }
  return false;
}

/** 10-digit local India → 91XXXXXXXXXX. Leaves already-prefixed / other-country numbers alone. */
export function normalizeIndiaPstn(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}

export function plivoXmlDialUser(opts: {
  callerId: string;
  sipUri: string;
  timeoutSeconds?: number;
  actionUrl?: string;
}): string {
  const timeout = opts.timeoutSeconds ?? 25;
  const actionAttr = opts.actionUrl
    ? ` action="${xmlEscape(opts.actionUrl)}" method="POST"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${xmlEscape(opts.callerId)}" timeout="${timeout}"${actionAttr}>
    <User>${xmlEscape(opts.sipUri)}</User>
  </Dial>
</Response>`;
}

export function plivoXmlDialNumber(opts: { callerId: string; number: string; actionUrl?: string }): string {
  const actionAttr = opts.actionUrl
    ? ` action="${xmlEscape(opts.actionUrl)}" method="POST"`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${xmlEscape(opts.callerId)}"${actionAttr}>
    <Number>${xmlEscape(opts.number)}</Number>
  </Dial>
</Response>`;
}

export function plivoXmlSpeak(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${xmlEscape(message)}</Speak>
</Response>`;
}
