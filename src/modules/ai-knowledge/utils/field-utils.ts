import { ObjectId } from 'mongodb';

export function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v)).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function pickFirst<T = unknown>(
  doc: Record<string, unknown>,
  keys: string[],
  fallback?: T
): T | undefined {
  for (const key of keys) {
    if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '') {
      return doc[key] as T;
    }
  }
  return fallback;
}

export function maskConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    if (url.password) url.password = '****';
    if (url.username) url.username = `${url.username.slice(0, 2)}****`;
    return connectionString.startsWith('mongodb+srv')
      ? url.href.replace(/^http:\/\//, 'mongodb+srv://')
      : url.href.replace(/^http:\/\//, 'mongodb://');
  } catch {
    return 'mongodb://****';
  }
}

export function isValidObjectId(value: string): boolean {
  return /^[a-f\d]{24}$/i.test(value);
}

export function toObjectId(value: string): ObjectId | null {
  if (!isValidObjectId(value)) return null;
  try {
    return new ObjectId(value);
  } catch {
    return null;
  }
}

export function docId(doc: Record<string, unknown>): string {
  const id = pickFirst(doc, ['id', '_id', 'uuid']);
  return asString(id);
}

export function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(asString(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
