import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { CallingError } from './calling.types.js';

export type CallGuestClaims = {
  /** purpose discriminator */
  purpose: 'call_guest';
  callId: string;
  workspaceId: string;
  contactId: string;
  jti: string;
  exp: number; // unix seconds
};

const SHORT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function guestSecret(): string {
  // Derive guest signing key from JWT secret — never expose to clients
  return createHmac('sha256', config.jwtSecret).update('call-guest-v1').digest('hex');
}

function b64url(data: string | Buffer): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** ~10 char opaque code for /c/{code} share links. */
export function newGuestShortCode(length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SHORT_ALPHABET[bytes[i]! % SHORT_ALPHABET.length];
  }
  return out;
}

/** Sign a short-lived guest token bound to one call + contact. */
export function signCallGuestToken(input: {
  callId: string;
  workspaceId: string;
  contactId: string;
  ttlSeconds?: number;
  /** Re-issue with existing jti/exp (short-link resolve). */
  jti?: string;
  expiresAt?: Date;
}): { token: string; jti: string; expiresAt: Date } {
  const expiresAt =
    input.expiresAt ??
    new Date(Date.now() + (input.ttlSeconds ?? config.livekit.guestTokenTtlSeconds) * 1000);
  const jti = input.jti ?? randomUUID();
  const claims: CallGuestClaims = {
    purpose: 'call_guest',
    callId: input.callId,
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    jti,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', guestSecret()).update(body).digest();
  return { token: `${body}.${b64url(sig)}`, jti, expiresAt };
}

export function verifyCallGuestToken(token: string): CallGuestClaims {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new CallingError('Invalid guest link', 401, 'guest_token_invalid');
  }
  const [body, sigB64] = parts;
  const expected = createHmac('sha256', guestSecret()).update(body).digest();
  let actual: Buffer;
  try {
    actual = fromB64url(sigB64);
  } catch {
    throw new CallingError('Invalid guest link', 401, 'guest_token_invalid');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new CallingError('Invalid guest link', 401, 'guest_token_invalid');
  }
  let claims: CallGuestClaims;
  try {
    claims = JSON.parse(fromB64url(body).toString('utf8')) as CallGuestClaims;
  } catch {
    throw new CallingError('Invalid guest link', 401, 'guest_token_invalid');
  }
  if (claims.purpose !== 'call_guest' || !claims.callId || !claims.workspaceId || !claims.jti) {
    throw new CallingError('Invalid guest link', 401, 'guest_token_invalid');
  }
  if (claims.exp * 1000 < Date.now()) {
    throw new CallingError('This call link has expired', 401, 'guest_token_expired');
  }
  return claims;
}

/** Public share link — short; resolves to /call/{id}?t=… */
export function buildCallGuestShortUrl(shortCode: string): string {
  const base = config.frontendUrl.replace(/\/$/, '');
  return `${base}/c/${encodeURIComponent(shortCode)}`;
}

/** Full call page URL after short-link resolve (token in query). */
export function buildCallGuestUrl(callId: string, token: string): string {
  const base = config.frontendUrl.replace(/\/$/, '');
  return `${base}/call/${encodeURIComponent(callId)}?t=${encodeURIComponent(token)}`;
}
