import { type Db, type Document, ObjectId } from 'mongodb';
import {
  COLLECTION_SCAN_PRIORITY,
  REFERENCE_FIELD_COLLECTION_HINTS,
  RESOLVER_LIMITS,
} from '../config/reference-map.js';
import type { ResolvedGraph, SyncLogEntry } from '../types/sync-log.types.js';
import {
  documentToPlain,
  extractObjectId,
  isPlainObject,
  objectIdToHex,
  visitKey,
} from '../utils/object-id-utils.js';

type PendingRef = {
  id: ObjectId;
  fieldName: string;
  preferredCollections: string[];
  depth: number;
};

type ResolverContext = {
  db: Db;
  availableCollections: Set<string>;
  visitedIds: Set<string>;
  documentCache: Map<string, { collection: string; doc: Record<string, unknown> }>;
  documentsByCollection: Map<string, Map<string, Record<string, unknown>>>;
  syncLogs: SyncLogEntry[];
  pendingQueue: PendingRef[];
  documentsResolved: number;
};

/**
 * Recursively resolves ObjectId and ObjectId[] references starting from a root document.
 * Read-only — never mutates external MongoDB data.
 */
export class RecursiveResolverService {
  async resolveFromDocument(
    db: Db,
    rootCollection: string,
    rootDocument: Document,
    availableCollectionNames: Iterable<string>
  ): Promise<ResolvedGraph> {
    const startedAt = Date.now();
    const ctx: ResolverContext = {
      db,
      availableCollections: new Set(availableCollectionNames),
      visitedIds: new Set<string>(),
      documentCache: new Map(),
      documentsByCollection: new Map(),
      syncLogs: [],
      pendingQueue: [],
      documentsResolved: 0,
    };

    const rootPlain = documentToPlain(rootDocument);
    const rootId = extractObjectId(rootPlain._id);
    if (rootId) {
      this.cacheDocument(ctx, rootCollection, rootId, rootPlain);
      ctx.visitedIds.add(visitKey(rootCollection, objectIdToHex(rootId)));
    }

    this.enqueueReferences(ctx, rootPlain, rootCollection, 0);

    while (ctx.pendingQueue.length > 0) {
      if (ctx.documentsResolved >= RESOLVER_LIMITS.maxDocuments) {
        this.pushLog(ctx, {
          collection: '*',
          documentsFetched: 0,
          durationMs: 0,
          action: 'skip',
          detail: `Document limit (${RESOLVER_LIMITS.maxDocuments}) reached`,
        });
        break;
      }

      const ref = ctx.pendingQueue.shift()!;
      if (ref.depth >= RESOLVER_LIMITS.maxDepth) continue;

      const idHex = objectIdToHex(ref.id);
      const cacheHit = [...ctx.documentCache.values()].find(
        (entry) => objectIdToHex(extractObjectId(entry.doc._id) ?? ref.id) === idHex
      );
      if (cacheHit) continue;

      const fetched = await this.fetchDocument(ctx, ref);
      if (!fetched) continue;

      const { collection, doc } = fetched;
      const vKey = visitKey(collection, idHex);
      if (ctx.visitedIds.has(vKey)) continue;

      ctx.visitedIds.add(vKey);
      ctx.documentsResolved += 1;
      this.cacheDocument(ctx, collection, ref.id, doc);
      this.enqueueReferences(ctx, doc, collection, ref.depth + 1);
    }

    const expandedRoot = (await this.expandValue(
      ctx,
      rootPlain,
      rootCollection,
      0,
      new Set()
    )) as Record<string, unknown>;

    const documentsByCollection: Record<string, Record<string, unknown>[]> = {};
    for (const [collection, docsMap] of ctx.documentsByCollection) {
      documentsByCollection[collection] = [...docsMap.values()];
    }

    const totalDurationMs = Date.now() - startedAt;

    return {
      rootCollection,
      expandedRoot,
      documentsByCollection,
      syncLogs: ctx.syncLogs,
      stats: {
        totalDocuments: ctx.documentsResolved,
        totalDurationMs,
        collectionsTouched: ctx.documentsByCollection.size,
      },
    };
  }

  private pushLog(ctx: ResolverContext, entry: SyncLogEntry): void {
    ctx.syncLogs.push(entry);
  }

  private cacheDocument(
    ctx: ResolverContext,
    collection: string,
    id: ObjectId,
    doc: Record<string, unknown>
  ): void {
    const idHex = objectIdToHex(id);
    ctx.documentCache.set(visitKey(collection, idHex), { collection, doc });

    if (!ctx.documentsByCollection.has(collection)) {
      ctx.documentsByCollection.set(collection, new Map());
    }
    ctx.documentsByCollection.get(collection)!.set(idHex, doc);
  }

  private inferCollections(fieldName: string, available: Set<string>): string[] {
    const direct = REFERENCE_FIELD_COLLECTION_HINTS[fieldName];
    if (direct) {
      return direct.filter((c) => available.has(c));
    }

    const candidates = new Set<string>();

    const normalized = fieldName
      .replace(/Ids$/i, '')
      .replace(/Id$/i, '')
      .replace(/_ids$/i, '')
      .replace(/_id$/i, '');

    for (const variant of [normalized, `${normalized}s`, `${normalized}es`]) {
      if (variant && available.has(variant)) candidates.add(variant);
    }

    for (const hint of Object.values(REFERENCE_FIELD_COLLECTION_HINTS).flat()) {
      if (hint.includes(normalized.toLowerCase()) && available.has(hint)) {
        candidates.add(hint);
      }
    }

    return [...candidates];
  }

  private enqueueReferences(
    ctx: ResolverContext,
    doc: Record<string, unknown>,
    sourceCollection: string,
    depth: number
  ): void {
    if (depth >= RESOLVER_LIMITS.maxDepth) return;

    for (const [fieldName, value] of Object.entries(doc)) {
      if (fieldName === '_id' || fieldName.startsWith('_')) continue;

      const oid = extractObjectId(value);
      if (oid) {
        this.enqueueRef(ctx, oid, fieldName, depth);
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const itemOid = extractObjectId(item);
          if (itemOid) {
            this.enqueueRef(ctx, itemOid, fieldName, depth);
          } else if (isPlainObject(item)) {
            this.enqueueReferences(ctx, item, sourceCollection, depth + 1);
          }
        }
        continue;
      }

      if (isPlainObject(value)) {
        this.enqueueReferences(ctx, value, sourceCollection, depth + 1);
      }
    }
  }

  private enqueueRef(ctx: ResolverContext, id: ObjectId, fieldName: string, depth: number): void {
    const preferredCollections = this.inferCollections(fieldName, ctx.availableCollections);
    ctx.pendingQueue.push({ id, fieldName, preferredCollections, depth });
  }

  private async fetchDocument(
    ctx: ResolverContext,
    ref: PendingRef
  ): Promise<{ collection: string; doc: Record<string, unknown> } | null> {
    const idHex = objectIdToHex(ref.id);

    for (const collection of ref.preferredCollections) {
      const hit = await this.findInCollection(ctx, collection, ref.id);
      if (hit) return hit;
    }

    for (const collection of COLLECTION_SCAN_PRIORITY) {
      if (!ctx.availableCollections.has(collection)) continue;
      if (ref.preferredCollections.includes(collection)) continue;
      const hit = await this.findInCollection(ctx, collection, ref.id);
      if (hit) {
        this.pushLog(ctx, {
          collection,
          documentsFetched: 1,
          durationMs: 0,
          action: 'discover',
          detail: `Discovered via scan for field "${ref.fieldName}"`,
        });
        return hit;
      }
    }

    this.pushLog(ctx, {
      collection: ref.preferredCollections[0] ?? 'unknown',
      documentsFetched: 0,
      durationMs: 0,
      action: 'skip',
      detail: `No document for ${idHex} (field: ${ref.fieldName})`,
    });
    return null;
  }

  private async findInCollection(
    ctx: ResolverContext,
    collectionName: string,
    id: ObjectId
  ): Promise<{ collection: string; doc: Record<string, unknown> } | null> {
    const started = Date.now();
    try {
      const doc = await ctx.db.collection(collectionName).findOne({ _id: id });
      const durationMs = Date.now() - started;

      if (!doc) {
        this.pushLog(ctx, {
          collection: collectionName,
          documentsFetched: 0,
          durationMs,
          action: 'fetch',
          detail: `Miss _id=${objectIdToHex(id)}`,
        });
        return null;
      }

      this.pushLog(ctx, {
        collection: collectionName,
        documentsFetched: 1,
        durationMs,
        action: 'fetch',
      });

      return { collection: collectionName, doc: documentToPlain(doc) };
    } catch (err) {
      this.pushLog(ctx, {
        collection: collectionName,
        documentsFetched: 0,
        durationMs: Date.now() - started,
        action: 'skip',
        detail: err instanceof Error ? err.message : 'Fetch error',
      });
      return null;
    }
  }

  private async expandValue(
    ctx: ResolverContext,
    value: unknown,
    fieldName: string,
    depth: number,
    expandingIds: Set<string>
  ): Promise<unknown> {
    if (depth >= RESOLVER_LIMITS.maxDepth) return value;

    const oid = extractObjectId(value);
    if (oid) {
      return this.expandReference(ctx, oid, fieldName, depth, expandingIds);
    }

    if (Array.isArray(value)) {
      const expanded: unknown[] = [];
      for (const item of value) {
        expanded.push(await this.expandValue(ctx, item, fieldName, depth + 1, expandingIds));
      }
      return expanded;
    }

    if (!isPlainObject(value)) return value;

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = await this.expandValue(ctx, nested, key, depth + 1, expandingIds);
    }
    return out;
  }

  private async expandReference(
    ctx: ResolverContext,
    id: ObjectId,
    fieldName: string,
    depth: number,
    expandingIds: Set<string>
  ): Promise<unknown> {
    const idHex = objectIdToHex(id);

    const cached = [...ctx.documentCache.entries()].find(([key]) => key.endsWith(`:${idHex}`));
    if (!cached) {
      return { _id: idHex, _unresolved: true, _field: fieldName };
    }

    const { collection, doc } = cached[1];
    const vKey = visitKey(collection, idHex);

    if (expandingIds.has(vKey)) {
      return { _id: idHex, _collection: collection, _circular: true };
    }

    expandingIds.add(vKey);
    const expanded: Record<string, unknown> = {
      _id: idHex,
      _collection: collection,
    };

    for (const [key, nested] of Object.entries(doc)) {
      if (key === '_id') continue;
      expanded[key] = await this.expandValue(ctx, nested, key, depth + 1, expandingIds);
    }

    expandingIds.delete(vKey);
    return expanded;
  }
}
