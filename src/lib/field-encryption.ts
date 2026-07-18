import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
/** Prefix so we can tell encrypted channel tokens from legacy plaintext. */
export const SECRET_PREFIX = 'csenc:v1:';

function getEncryptionKey(): Buffer {
  const raw =
    process.env.EMAIL_CONFIG_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_KEY ||
    process.env.JWT_SECRET;
  if (!raw) {
    throw new Error('EMAIL_CONFIG_ENCRYPTION_KEY (or JWT_SECRET fallback) is required');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptJson(value: Record<string, unknown>): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = JSON.stringify(value);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptJson<T extends Record<string, unknown>>(payload: string): T {
  if (!payload) return {} as T;
  const key = getEncryptionKey();
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buf.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

export function hasEncryptedPayload(payload: string | null | undefined): boolean {
  return Boolean(payload && payload.length > 0);
}

/** Encrypt a single secret string (channel tokens). Reuses AES-256-GCM via encryptJson. */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (plaintext.startsWith(SECRET_PREFIX)) return plaintext;
  return `${SECRET_PREFIX}${encryptJson({ v: plaintext })}`;
}

/**
 * Decrypt a channel secret. Legacy plaintext (no prefix) is returned as-is
 * until the migration script encrypts it.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(SECRET_PREFIX)) return stored;
  try {
    const { v } = decryptJson<{ v: string }>(stored.slice(SECRET_PREFIX.length));
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function isSecretStored(stored: string | null | undefined): boolean {
  return Boolean(stored && stored.length > 0);
}

export function requireDecryptedSecret(
  stored: string | null | undefined,
  label = 'secret'
): string {
  const value = decryptSecret(stored);
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

/** Encrypt only if still plaintext — safe for migration / re-runs. */
export function encryptSecretIfPlain(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith(SECRET_PREFIX)) return stored;
  return encryptSecret(stored);
}
