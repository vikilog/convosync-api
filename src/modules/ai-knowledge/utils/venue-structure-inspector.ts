import type { Document } from 'mongodb';
import type { FieldStructureEntry, VenueStructureReport } from '../types/debug.types.js';
import { documentToPlain, extractObjectId, isPlainObject } from './object-id-utils.js';
import { asString } from './field-utils.js';

const LOG_PREFIX = '[AI Knowledge Sync]';
const MAX_DEPTH = 10;

function valueType(value: unknown): FieldStructureEntry['type'] {
  if (value == null) return 'null';
  if (extractObjectId(value)) return 'objectId';
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'other';
}

function walkDocument(
  value: unknown,
  path: string,
  depth: number,
  fields: FieldStructureEntry[],
  objectIdPaths: string[],
  arraySummaries: VenueStructureReport['arraySummaries']
): void {
  if (depth > MAX_DEPTH) return;

  const type = valueType(value);
  const entry: FieldStructureEntry = { path, type };

  const oid = extractObjectId(value);
  if (oid) {
    entry.objectIdHex = oid.toHexString();
    objectIdPaths.push(path);
    fields.push(entry);
    return;
  }

  if (Array.isArray(value)) {
    entry.arrayLength = value.length;
    const first = value[0];
    const itemType = first == null ? 'empty' : valueType(first);
    arraySummaries.push({ path, length: value.length, itemType });
    fields.push(entry);

    for (let i = 0; i < Math.min(value.length, 5); i++) {
      walkDocument(value[i], `${path}[${i}]`, depth + 1, fields, objectIdPaths, arraySummaries);
    }
    return;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    entry.nestedObjectKeys = keys;
    fields.push(entry);

    for (const key of keys) {
      walkDocument(value[key], path ? `${path}.${key}` : key, depth + 1, fields, objectIdPaths, arraySummaries);
    }
    return;
  }

  if (typeof value === 'string' && value.length <= 120) {
    entry.sampleValue = value;
  }
  fields.push(entry);
}

/** Inspects venue document structure and emits detailed console logs. */
export function inspectVenueStructure(
  venueDocument: Document | null,
  venueCollection: string | null,
  venueId: string
): VenueStructureReport {
  const plain = venueDocument ? documentToPlain(venueDocument) : null;
  const topLevelKeys = plain ? Object.keys(plain) : [];
  const fields: FieldStructureEntry[] = [];
  const objectIdPaths: string[] = [];
  const arraySummaries: VenueStructureReport['arraySummaries'] = [];

  console.log(`${LOG_PREFIX} ── Venue structure inspection ──`);
  console.log(`${LOG_PREFIX} Venue collection: ${venueCollection ?? '(not found)'}`);
  console.log(`${LOG_PREFIX} Venue ID filter: ${venueId}`);

  if (!plain) {
    console.warn(`${LOG_PREFIX} Venue document: NOT FOUND`);
    return {
      venueCollection,
      venueId,
      topLevelKeys: [],
      fields: [],
      objectIdPaths: [],
      arraySummaries: [],
      objectIdCount: 0,
    };
  }

  console.log(`${LOG_PREFIX} Venue top-level keys (${topLevelKeys.length}):`, topLevelKeys.join(', '));

  for (const key of topLevelKeys) {
    walkDocument(plain[key], key, 0, fields, objectIdPaths, arraySummaries);
  }

  for (const arr of arraySummaries) {
    console.log(
      `${LOG_PREFIX} Array ${arr.path}: length=${arr.length}, itemType=${arr.itemType}`
    );
  }

  for (const oidPath of objectIdPaths) {
    const entry = fields.find((f) => f.path === oidPath);
    console.log(`${LOG_PREFIX} ObjectId ${oidPath}: ${entry?.objectIdHex ?? '?'}`);
  }

  for (const field of fields.filter((f) => f.type === 'object' && f.nestedObjectKeys)) {
    console.log(
      `${LOG_PREFIX} Nested object ${field.path} keys:`,
      field.nestedObjectKeys!.join(', ')
    );
  }

  console.log(
    `${LOG_PREFIX} Summary: ${objectIdPaths.length} ObjectId(s), ${arraySummaries.length} array(s), ${topLevelKeys.length} top-level key(s)`
  );

  return {
    venueCollection,
    venueId,
    topLevelKeys,
    fields,
    objectIdPaths,
    arraySummaries,
    objectIdCount: objectIdPaths.length,
  };
}

export function venueDocumentPreview(venueDocument: Document | null): Record<string, unknown> | null {
  if (!venueDocument) return null;
  return documentToPlain(venueDocument);
}
