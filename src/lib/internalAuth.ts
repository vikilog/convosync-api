import { safeStringEquals } from '../utils/crypto.utils.js';

/** 204 = ok, 401 = bad/missing header, 503 = secret unset (fail closed). */
export function internalAuthCode(expected: string, got: string): 204 | 401 | 503 {
  if (!expected) return 503;
  if (!safeStringEquals(expected, got)) return 401;
  return 204;
}

export function internalAuthHeaders(secret: string): Record<string, string> {
  if (!secret) {
    throw new Error('CONVOSYNC_INTERNAL_SECRET is not configured');
  }
  return { 'X-ConvoSync-Internal': secret };
}
