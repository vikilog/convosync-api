import { ObjectId, type Document } from 'mongodb';

export function objectIdToHex(value: ObjectId): string {
  return value.toHexString();
}

export function visitKey(collection: string, idHex: string): string {
  return `${collection}:${idHex}`;
}

/** Detect BSON ObjectId, extended JSON, or 24-char hex string. */
export function extractObjectId(value: unknown): ObjectId | null {
  if (value instanceof ObjectId) return value;
  if (typeof value === 'string' && ObjectId.isValid(value)) {
    try {
      return new ObjectId(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj._bsontype === 'ObjectId' && typeof obj.toHexString === 'function') {
      return value as ObjectId;
    }
    if (typeof obj.$oid === 'string' && ObjectId.isValid(obj.$oid)) {
      return new ObjectId(obj.$oid);
    }
  }
  return null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') return false;
  if (value instanceof ObjectId) return false;
  if (value instanceof Date) return false;
  if (Array.isArray(value)) return false;
  if (value instanceof RegExp) return false;
  return true;
}

export function documentToPlain(doc: Document): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}
