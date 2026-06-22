import { type Db, type Document, type Filter } from 'mongodb';
import type { CollectionDiscoveryLog } from '../types/debug.types.js';
import { documentToPlain, isPlainObject } from '../utils/object-id-utils.js';
import { isValidObjectId, toObjectId } from '../utils/field-utils.js';
import { isEntityLikeCollection, mapConcurrent } from '../utils/collection-resolver.js';
import {
  DEFAULT_VENUE_SCOPE_FIELDS,
  type VenueScopeContext,
  VENUE_SCOPE_FIELD_PATTERN,
  filterDocsByVenueMembership,
} from '../utils/venue-scope-fields.js';

const LOG_PREFIX = '[AI Knowledge Sync]';
const SAMPLE_SIZE = 3;
const DOC_LIMIT = 500;
const DISCOVERY_CONCURRENCY = 12;
const MAX_DISCOVERY_MS = 45_000;

const SYSTEM_COLLECTION_PREFIXES = ['system.', 'local.'];

export type DynamicDiscoveryResult = {
  collections: Record<string, Document[]>;
  logs: CollectionDiscoveryLog[];
  totalDocuments: number;
  timedOut?: boolean;
};

/**
 * Discovers venue-scoped documents by scanning collections in parallel.
 * Only queries collections that have venue scope fields in samples OR look like entity collections.
 */
export class DynamicCollectionDiscoveryService {
  async discoverByVenueId(
    db: Db,
    venueId: string,
    collectionNames: Iterable<string>,
    excludeCollections: Set<string> = new Set(),
    venueContext: VenueScopeContext = {}
  ): Promise<DynamicDiscoveryResult> {
    const collections: Record<string, Document[]> = {};
    const startedAt = Date.now();
    const names = [...collectionNames].filter((n) => !this.shouldSkipCollection(n, excludeCollections));

    console.log(
      `${LOG_PREFIX} ── Dynamic collection discovery (${names.length} collections, concurrency ${DISCOVERY_CONCURRENCY}) ──`
    );

    const results = await mapConcurrent(names, DISCOVERY_CONCURRENCY, async (collectionName) => {
      if (Date.now() - startedAt > MAX_DISCOVERY_MS) {
        return {
          collection: collectionName,
          docs: [] as Document[],
          log: {
            collection: collectionName,
            documentsFound: 0,
            durationMs: 0,
            scopeFieldsTried: [],
            sampleTopLevelKeys: [],
            detail: 'Skipped — discovery time budget exceeded',
          } satisfies CollectionDiscoveryLog,
        };
      }

      return this.probeCollection(db, collectionName, venueId, venueContext);
    });

    const logs: CollectionDiscoveryLog[] = [];
    let totalDocuments = 0;

    for (const result of results) {
      logs.push(result.log);
      if (result.docs.length > 0) {
        collections[result.collection] = result.docs;
        totalDocuments += result.docs.length;
        console.log(
          `${LOG_PREFIX} Collection "${result.collection}": ${result.docs.length} document(s) in ${result.log.durationMs}ms (fields: ${result.log.scopeFieldsTried.join(', ') || 'venueId'})`
        );
      }
    }

    const timedOut = Date.now() - startedAt > MAX_DISCOVERY_MS;
    const withDocs = logs.filter((l) => l.documentsFound > 0).length;
    console.log(
      `${LOG_PREFIX} Discovery complete: ${totalDocuments} document(s) across ${withDocs} collection(s) in ${Date.now() - startedAt}ms${timedOut ? ' (time budget reached)' : ''}`
    );

    return { collections, logs, totalDocuments, timedOut };
  }

  /** Public entry for single-collection sync. */
  async fetchCollectionForVenue(
    db: Db,
    collectionName: string,
    venueId: string,
    venueContext: VenueScopeContext = {}
  ): Promise<{ docs: Document[]; log: CollectionDiscoveryLog }> {
    const result = await this.probeCollection(db, collectionName, venueId, venueContext);
    return { docs: result.docs, log: result.log };
  }

  private async probeCollection(
    db: Db,
    collectionName: string,
    venueId: string,
    venueContext: VenueScopeContext = {}
  ): Promise<{ collection: string; docs: Document[]; log: CollectionDiscoveryLog }> {
    const started = Date.now();
    const scopeFields = await this.detectScopeFields(db, collectionName);
    const isEntity = isEntityLikeCollection(collectionName);
    const isVenueRoot = /^venue(s)?$/i.test(collectionName);

    if (scopeFields.length === 0 && !isEntity && !isVenueRoot) {
      return {
        collection: collectionName,
        docs: [],
        log: {
          collection: collectionName,
          documentsFound: 0,
          durationMs: Date.now() - started,
          scopeFieldsTried: [],
          sampleTopLevelKeys: [],
          detail: 'Skipped — no scope fields and not an entity collection',
        },
      };
    }

    const fieldsToTry = isVenueRoot
      ? ['_id']
      : [
          ...new Set([
            ...scopeFields,
            ...(isEntity || scopeFields.length === 0 ? DEFAULT_VENUE_SCOPE_FIELDS : []),
          ]),
        ];

    let docs: Document[] = [];

    if (isVenueRoot && isValidObjectId(venueId)) {
      const doc = await db.collection(collectionName).findOne({ _id: toObjectId(venueId)! });
      if (doc) docs = [doc];
    } else {
      docs = await this.queryCombined(db, collectionName, fieldsToTry, venueId, venueContext);
      docs = filterDocsByVenueMembership(docs, venueId);
    }

    const durationMs = Date.now() - started;
    return {
      collection: collectionName,
      docs,
      log: {
        collection: collectionName,
        documentsFound: docs.length,
        durationMs,
        scopeFieldsTried: fieldsToTry,
        sampleTopLevelKeys: scopeFields,
        detail:
          docs.length === 0
            ? scopeFields.length
              ? 'No documents matched venue scope fields'
              : 'Entity collection — tried venueId'
            : undefined,
      },
    };
  }

  private shouldSkipCollection(name: string, exclude: Set<string>): boolean {
    if (exclude.has(name)) return true;
    if (name.startsWith('_')) return true;
    if (name.length <= 1) return true;
    return SYSTEM_COLLECTION_PREFIXES.some((p) => name.startsWith(p));
  }

  private async detectScopeFields(db: Db, collectionName: string): Promise<string[]> {
    try {
      const fullSamples = await db.collection(collectionName).find({}).limit(SAMPLE_SIZE).toArray();
      const fields = new Set<string>();

      for (const doc of fullSamples) {
        const plain = documentToPlain(doc);
        for (const key of Object.keys(plain)) {
          if (VENUE_SCOPE_FIELD_PATTERN.test(key)) {
            fields.add(key);
          }
        }
      }

      return [...fields];
    } catch {
      return [];
    }
  }

  /** Single round-trip: one $or query with all venue scope variants. */
  private async queryCombined(
    db: Db,
    collectionName: string,
    fields: string[],
    venueId: string,
    venueContext: VenueScopeContext = {}
  ): Promise<Document[]> {
    const collection = db.collection(collectionName);
    const orClauses: Filter<Document>[] = [];
    const oid = toObjectId(venueId);

    const addFieldVariants = (field: string, value: string) => {
      const valueOid = toObjectId(value);
      orClauses.push({ [field]: value });
      if (valueOid) {
        orClauses.push({ [field]: valueOid });
        // Array fields (venueIds) and scalar refs both match { field: ObjectId } in MongoDB.
        orClauses.push({ [field]: { $in: [valueOid, value] } });
        if (/^(venue|branch|salon|location|business|company|store)$/i.test(field)) {
          orClauses.push({ [`${field}._id`]: valueOid });
        }
      }
    };

    for (const field of fields) {
      addFieldVariants(field, venueId);
    }

    if (venueContext.partnerId) {
      addFieldVariants('partnerId', venueContext.partnerId);
      addFieldVariants('partner_id', venueContext.partnerId);
    }
    if (venueContext.franchiseId) {
      addFieldVariants('franchiseId', venueContext.franchiseId);
      addFieldVariants('franchise_id', venueContext.franchiseId);
    }

    if (orClauses.length === 0) return [];

    try {
      return await collection.find({ $or: orClauses }).limit(DOC_LIMIT).toArray();
    } catch {
      return [];
    }
  }

  private docKey(doc: Document): string | null {
    const plain = isPlainObject(doc) ? doc : documentToPlain(doc);
    const id = plain._id ?? plain.id;
    if (id == null) return null;
    if (typeof id === 'string') return id;
    if (typeof id === 'object' && id !== null && '$oid' in id) {
      return String((id as { $oid: string }).$oid);
    }
    if (typeof (id as { toHexString?: () => string }).toHexString === 'function') {
      return (id as { toHexString: () => string }).toHexString();
    }
    return String(id);
  }
}
