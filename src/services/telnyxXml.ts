/**
 * Telnyx TeXML helpers — mirrors plivoXml.ts's shape so the answer_url/hangup_url
 * flow (webhook hit → we return XML telling Telnyx what to do next) stays structurally
 * identical between providers. TeXML's Dial noun for a SIP/WebRTC endpoint is <Sip>
 * (Plivo's is <User>); for a PSTN number both providers use <Number>.
 * https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/dial
 */

export const TELNYX_SIP_DOMAIN = 'sip.telnyx.com';

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SIP URI TeXML expects inside `<Sip>` when ringing a Telnyx WebRTC endpoint. */
export function sipUriForEndpoint(username: string): string {
  const trimmed = username.trim();
  if (/^sip:/i.test(trimmed)) return trimmed;
  return `sip:${trimmed}@${TELNYX_SIP_DOMAIN}`;
}

/** Username from a From/To SIP URI like `sip:cs_foo1234@sip.telnyx.com`. */
export function endpointUsernameFromSip(from: string): string | null {
  const trimmed = from.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^sip:/i, '');
  const user = withoutScheme.split('@')[0]?.split(';')[0]?.trim();
  return user || null;
}

export function isTelnyxEndpointSip(from: string): boolean {
  return /@(sip|rtc)\.telnyx\.com/i.test(from) || /^sip:/i.test(from);
}

/** X-Telnyx-CallerId (and casing/underscore variants) the browser client sends on outbound. */
export function extraHeaderCallerId(body: Record<string, string>): string {
  for (const [key, value] of Object.entries(body)) {
    if (key.toLowerCase().replace(/_/g, '-').includes('callerid')) {
      const digits = String(value).replace(/\D/g, '');
      if (digits) return digits;
    }
  }
  return '';
}

/** International numbers arrive with a leading +; TeXML/Telnyx wants bare E.164 digits
 * (no +) for <Number>, same convention the app already stores numbers in. Unlike Plivo's
 * India-only normalizer, Telnyx-routed numbers are always already-prefixed E.164 (US/GB/SG
 * numbers this app buys are stored with country code), so this only strips a leading '+'. */
export function normalizeE164ForDial(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

export function texmlDialSip(opts: {
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
    <Sip>${xmlEscape(opts.sipUri)}</Sip>
  </Dial>
</Response>`;
}

export function texmlDialNumber(opts: { callerId: string; number: string; actionUrl?: string }): string {
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

export function texmlSpeak(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${xmlEscape(message)}</Say>
</Response>`;
}
