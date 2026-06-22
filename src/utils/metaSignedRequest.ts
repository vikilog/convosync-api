import crypto from 'node:crypto';

export type MetaSignedRequestPayload = {
  algorithm?: string;
  issued_at?: number;
  user_id?: string;
};

/** Parse and verify Meta `signed_request` (deauthorize / data deletion callbacks). */
export function parseMetaSignedRequest(
  signedRequest: string,
  appSecret: string
): MetaSignedRequestPayload | null {
  if (!signedRequest || !appSecret) return null;

  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;

  const [encodedSig, payload] = parts;
  if (!encodedSig || !payload) return null;

  let sig: Buffer;
  try {
    sig = base64UrlDecode(encodedSig);
  } catch {
    return null;
  }

  const expectedSig = crypto.createHmac('sha256', appSecret).update(payload).digest();
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    return null;
  }

  try {
    const json = JSON.parse(base64UrlDecode(payload).toString('utf8')) as MetaSignedRequestPayload;
    if (json.algorithm && json.algorithm !== 'HMAC-SHA256') return null;
    return json;
  } catch {
    return null;
  }
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}
