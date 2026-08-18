import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export type UnsubscribeClaims = {
  purpose: 'email_unsubscribe';
  contactId: string;
  workspaceId: string;
};

function unsubscribeSecret(): string {
  // Derive from the JWT secret rather than reusing it directly — never expose it to clients.
  return createHmac('sha256', config.jwtSecret).update('email-unsubscribe-v1').digest('hex');
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

/** No expiry — an unsubscribe link in an old email a recipient finds months later must still work. */
export function signUnsubscribeToken(contactId: string, workspaceId: string): string {
  const claims: UnsubscribeClaims = { purpose: 'email_unsubscribe', contactId, workspaceId };
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', unsubscribeSecret()).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribeClaims {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid unsubscribe link');
  }
  const [body, sigB64] = parts;
  const expected = createHmac('sha256', unsubscribeSecret()).update(body).digest();
  let actual: Buffer;
  try {
    actual = fromB64url(sigB64);
  } catch {
    throw new Error('Invalid unsubscribe link');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid unsubscribe link');
  }
  let claims: UnsubscribeClaims;
  try {
    claims = JSON.parse(fromB64url(body).toString('utf8')) as UnsubscribeClaims;
  } catch {
    throw new Error('Invalid unsubscribe link');
  }
  if (claims.purpose !== 'email_unsubscribe' || !claims.contactId || !claims.workspaceId) {
    throw new Error('Invalid unsubscribe link');
  }
  return claims;
}

export function buildUnsubscribeUrl(contactId: string, workspaceId: string): string {
  const token = signUnsubscribeToken(contactId, workspaceId);
  return `${config.backendPublicUrl}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
}
