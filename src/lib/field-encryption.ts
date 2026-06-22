import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

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
