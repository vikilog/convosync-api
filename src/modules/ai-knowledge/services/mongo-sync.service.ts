import { MongoClient, type Db, type Document, type Filter } from 'mongodb';
import {
  COLLECTION_CANDIDATES,
  type CollectionKey,
  VENUE_ID_FIELDS,
} from '../config/collection-map.js';
import type { ResolvedGraph } from '../types/sync-log.types.js';
import type { AiKnowledgeDebug } from '../types/debug.types.js';
import { isValidObjectId, toObjectId } from '../utils/field-utils.js';
import {
  documentsToPlainCollections,
  mergeAnyCollectionsIntoBundle,
  mergeResolvedIntoBundle,
} from '../utils/merge-resolved-docs.js';
import {
  inspectVenueStructure,
  venueDocumentPreview,
} from '../utils/venue-structure-inspector.js';
import { buildCollectionIndex, isEntityLikeCollection, resolveCollectionName } from '../utils/collection-resolver.js';
import { sortCollectionsForSync } from '../utils/bundle-builder.js';
import { extractVenueScopeContext } from '../utils/venue-scope-fields.js';
import { DynamicCollectionDiscoveryService } from './dynamic-collection-discovery.service.js';
import { RecursiveResolverService } from './recursive-resolver.service.js';

export type RawMongoBundle = {
  discoveredCollections: string[];
  salon: Document | null;
  services: Document[];
  staff: Document[];
  customers: Document[];
  memberships: Document[];
  packages: Document[];
  vouchers: Document[];
  products: Document[];
  faqs: Document[];
  policies: Document[];
  branches: Document[];
  serviceCategories: Document[];
  businessSettings: Document | null;
  /** Output of recursive ObjectId resolution starting from venue/salon. */
  resolvedGraph?: ResolvedGraph;
  /** Debug snapshot persisted to ai_knowledge.debug before normalization. */
  debug?: import('../types/debug.types.js').AiKnowledgeDebug;
  /** All dynamically discovered documents keyed by MongoDB collection name. */
  discoveredByCollection?: Record<string, Document[]>;
  bookings: Document[];
};

export type SyncProgressCallback = (step: number, totalSteps: number, message: string) => void;

const READ_ONLY_OPTIONS = {
  readPreference: 'secondaryPreferred' as const,
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 15_000,
  connectTimeoutMS: 15_000,
};

/**
 * Read-only dynamic MongoDB access for external salon databases.
 * Never writes or mutates external data.
 */
export class MongoSyncService {
  constructor(
    private readonly resolver = new RecursiveResolverService(),
    private readonly discovery = new DynamicCollectionDiscoveryService()
  ) {}
  async withConnection<T>(
    connectionString: string,
    fn: (db: Db) => Promise<T>
  ): Promise<T> {
    const client = new MongoClient(connectionString, READ_ONLY_OPTIONS);
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
      return await fn(client.db());
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async testConnection(connectionString: string): Promise<void> {
    await this.withConnection(connectionString, async (db) => {
      await db.command({ ping: 1 });
    });
  }

  /** List entity-like MongoDB collections (read-only, fast — no document fetch). */
  async listEntityCollections(connectionString: string): Promise<string[]> {
    return this.withConnection(connectionString, async (db) => {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();

      const names = collections
        .map((c) => c.name)
        .filter((name) => !name.startsWith('_') && isEntityLikeCollection(name));

      return sortCollectionsForSync(names);
    });
  }

  /** Fetch documents for a single collection scoped to venueId (read-only). */
  async fetchSingleCollection(
    connectionString: string,
    venueId: string,
    collectionName: string,
    venueContext: import('../utils/venue-scope-fields.js').VenueScopeContext = {}
  ): Promise<{ docs: Document[]; log: import('../types/debug.types.js').CollectionDiscoveryLog }> {
    return this.withConnection(connectionString, async (db) => {
      const result = await this.discovery.fetchCollectionForVenue(
        db,
        collectionName,
        venueId,
        venueContext
      );
      console.log(
        `[AI Knowledge Sync] Single collection "${collectionName}": ${result.docs.length} document(s) in ${result.log.durationMs}ms`
      );
      return result;
    });
  }

  buildVenueFilter(venueId: string): Filter<Document> {
    const clauses: Filter<Document>[] = [];

    for (const field of VENUE_ID_FIELDS) {
      clauses.push({ [field]: venueId });
    }

    const oid = toObjectId(venueId);
    if (oid) {
      clauses.push({ _id: oid });
      for (const field of VENUE_ID_FIELDS) {
        clauses.push({ [field]: oid });
      }
    }

    return { $or: clauses };
  }

  private resolveCollection(
    index: Map<string, string>,
    key: CollectionKey
  ): string | null {
    return resolveCollectionName(index, COLLECTION_CANDIDATES[key]);
  }

  private async findManyForVenue(
    db: Db,
    collectionName: string,
    venueId: string,
    limit = 500
  ): Promise<Document[]> {
    const collection = db.collection(collectionName);
    const venueFilter = this.buildVenueFilter(venueId);
    const withVenue = await collection.find(venueFilter).limit(limit).toArray();
    if (withVenue.length > 0) return withVenue;

    // Some deployments store venue id only on parent salon doc — return all if small set.
    const count = await collection.estimatedDocumentCount();
    if (count > 0 && count <= limit) {
      return collection.find({}).limit(limit).toArray();
    }
    return [];
  }

  private async findOneForVenue(
    db: Db,
    collectionName: string,
    venueId: string
  ): Promise<Document | null> {
    const collection = db.collection(collectionName);
    const venueFilter = this.buildVenueFilter(venueId);
    const doc = await collection.findOne(venueFilter);
    if (doc) return doc;

    if (isValidObjectId(venueId)) {
      return collection.findOne({ _id: toObjectId(venueId)! });
    }
    return null;
  }

  async extractSalonData(
    connectionString: string,
    venueId: string,
    onProgress?: SyncProgressCallback
  ): Promise<RawMongoBundle> {
    return this.withConnection(connectionString, async (db) => {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      const collectionNames = collections.map((c) => c.name);
      const names = new Set(collectionNames);
      const collectionIndex = buildCollectionIndex(collectionNames);
      onProgress?.(1, 15, `Connected — ${collectionNames.length} collections found`);

      const resolve = (key: CollectionKey) => this.resolveCollection(collectionIndex, key);

      const salonCol = await resolve('salon');
      const servicesCol = await resolve('services');
      const staffCol = await resolve('staff');
      const customersCol = await resolve('customers');
      const membershipsCol = await resolve('memberships');
      const packagesCol = await resolve('packages');
      const vouchersCol = await resolve('vouchers');
      const productsCol = await resolve('products');
      const faqsCol = await resolve('faqs');
      const policiesCol = await resolve('policies');
      const branchesCol = await resolve('branches');
      const categoriesCol = await resolve('serviceCategories');
      const settingsCol = await resolve('businessSettings');

      onProgress?.(2, 15, 'Fetching salon profile');
      const salon = salonCol ? await this.findOneForVenue(db, salonCol, venueId) : null;

      onProgress?.(3, 15, 'Inspecting venue document structure');
      const venueStructure = inspectVenueStructure(salon, salonCol, venueId);
      const objectIdsInVenue = venueStructure.objectIdCount;

      onProgress?.(4, 15, 'Dynamic discovery — scanning all collections by venueId');
      const excludeFromDiscovery = new Set<string>();
      if (salonCol) excludeFromDiscovery.add(salonCol);

      const venueContext = extractVenueScopeContext(
        salon as Record<string, unknown> | null
      );

      const dynamicResult = await this.discovery.discoverByVenueId(
        db,
        venueId,
        names,
        excludeFromDiscovery,
        venueContext
      );

      onProgress?.(
        4,
        15,
        `Dynamic discovery: ${dynamicResult.totalDocuments} doc(s) in ${Object.keys(dynamicResult.collections).length} collection(s)`
      );

      onProgress?.(5, 15, 'Resolving referenced documents');
      let resolvedGraph: ResolvedGraph | undefined;
      const allSyncLogs: import('../types/sync-log.types.js').SyncLogEntry[] = [];

      if (salon && salonCol) {
        resolvedGraph = await this.resolver.resolveFromDocument(
          db,
          salonCol,
          salon,
          names
        );
        allSyncLogs.push(...resolvedGraph.syncLogs);
        onProgress?.(
          5,
          15,
          `Resolved ${resolvedGraph.stats.totalDocuments} referenced document(s) (${resolvedGraph.stats.totalDurationMs}ms)`
        );
      } else if (objectIdsInVenue === 0) {
        console.log(
          '[AI Knowledge Sync] No ObjectIds in venue document — relying on dynamic venueId queries'
        );
      }

      onProgress?.(6, 15, 'Fetching services');
      const services = servicesCol
        ? await this.findManyForVenue(db, servicesCol, venueId, 1000)
        : [];

      onProgress?.(7, 15, 'Fetching staff');
      const staff = staffCol ? await this.findManyForVenue(db, staffCol, venueId, 500) : [];

      onProgress?.(8, 15, 'Fetching customers');
      const customers = customersCol
        ? await this.findManyForVenue(db, customersCol, venueId, 500)
        : [];

      onProgress?.(9, 15, 'Fetching memberships & packages');
      const memberships = membershipsCol
        ? await this.findManyForVenue(db, membershipsCol, venueId, 200)
        : [];
      const packages = packagesCol
        ? await this.findManyForVenue(db, packagesCol, venueId, 200)
        : [];

      onProgress?.(10, 15, 'Fetching vouchers');
      const vouchers = vouchersCol
        ? await this.findManyForVenue(db, vouchersCol, venueId, 200)
        : [];

      onProgress?.(11, 15, 'Fetching products');
      const products = productsCol
        ? await this.findManyForVenue(db, productsCol, venueId, 500)
        : [];

      onProgress?.(12, 15, 'Fetching FAQs & policies');
      const faqs = faqsCol ? await this.findManyForVenue(db, faqsCol, venueId, 200) : [];
      const policies = policiesCol
        ? await this.findManyForVenue(db, policiesCol, venueId, 100)
        : [];

      onProgress?.(13, 15, 'Fetching branches & categories');
      const branches = branchesCol
        ? await this.findManyForVenue(db, branchesCol, venueId, 50)
        : [];
      const serviceCategories = categoriesCol
        ? await this.findManyForVenue(db, categoriesCol, venueId, 100)
        : [];

      onProgress?.(14, 15, 'Fetching business settings');
      const businessSettings = settingsCol
        ? await this.findOneForVenue(db, settingsCol, venueId)
        : null;

      onProgress?.(15, 15, 'Merging discovered data');

      let bundle: RawMongoBundle = {
        discoveredCollections: [...names],
        salon,
        services,
        staff,
        customers,
        memberships,
        packages,
        vouchers,
        products,
        faqs,
        policies,
        branches,
        serviceCategories,
        businessSettings,
        bookings: [],
        resolvedGraph,
        discoveredByCollection: dynamicResult.collections,
      };

      // Merge dynamic discovery first (venueId-scoped queries across all collections)
      bundle = mergeAnyCollectionsIntoBundle(bundle, dynamicResult.collections);

      if (resolvedGraph) {
        bundle = mergeResolvedIntoBundle(bundle, resolvedGraph.documentsByCollection);
        bundle.resolvedGraph = resolvedGraph;
      }

      const discoveredPlain = documentsToPlainCollections(dynamicResult.collections);

      const appendToDiscovered = (collectionName: string | null, docs: Document[]) => {
        if (!collectionName || docs.length === 0) return;
        const existing = discoveredPlain[collectionName] ?? [];
        const merged = new Map<string, unknown>();
        for (const doc of existing) {
          const id = String((doc as Record<string, unknown>)._id ?? '');
          if (id) merged.set(id, doc);
        }
        for (const doc of docs) {
          const plain = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
          const id = String(plain._id ?? '');
          if (id && !merged.has(id)) merged.set(id, plain);
        }
        discoveredPlain[collectionName] = [...merged.values()];
      };

      appendToDiscovered(servicesCol, bundle.services);
      appendToDiscovered(staffCol, bundle.staff);
      appendToDiscovered(customersCol, bundle.customers);
      appendToDiscovered(membershipsCol, bundle.memberships);
      appendToDiscovered(packagesCol, bundle.packages);
      appendToDiscovered(vouchersCol, bundle.vouchers);
      appendToDiscovered(productsCol, bundle.products);
      appendToDiscovered(faqsCol, bundle.faqs);
      appendToDiscovered(policiesCol, bundle.policies);
      appendToDiscovered(branchesCol, bundle.branches);
      appendToDiscovered(categoriesCol, bundle.serviceCategories);
      if (salonCol && salon) appendToDiscovered(salonCol, [salon]);
      if (settingsCol && businessSettings) appendToDiscovered(settingsCol, [businessSettings]);

      const bulkDiscoveryLogs = [
        { col: servicesCol, docs: bundle.services, label: 'services (bulk)' },
        { col: staffCol, docs: bundle.staff, label: 'staff (bulk)' },
        { col: customersCol, docs: bundle.customers, label: 'customers (bulk)' },
        { col: productsCol, docs: bundle.products, label: 'products (bulk)' },
        { col: membershipsCol, docs: bundle.memberships, label: 'memberships (bulk)' },
        { col: vouchersCol, docs: bundle.vouchers, label: 'vouchers (bulk)' },
        { col: packagesCol, docs: bundle.packages, label: 'packages (bulk)' },
      ].filter((e) => e.col);

      for (const entry of bulkDiscoveryLogs) {
        dynamicResult.logs.push({
          collection: entry.col!,
          documentsFound: entry.docs.length,
          durationMs: 0,
          scopeFieldsTried: ['venue-scoped bulk fetch'],
          sampleTopLevelKeys: [],
          detail: entry.label,
        });
      }

      if (salonCol && salon && !discoveredPlain[salonCol]) {
        discoveredPlain[salonCol] = [venueDocumentPreview(salon)!];
      }

      const debugPayload: AiKnowledgeDebug = {
        inspectedAt: new Date().toISOString(),
        venueStructure,
        discoveryLogs: dynamicResult.logs,
        syncLogs: [
          ...allSyncLogs,
          ...dynamicResult.logs.map((log) => ({
            collection: log.collection,
            documentsFetched: log.documentsFound,
            durationMs: log.durationMs,
            action: 'discover' as const,
            detail: log.detail ?? log.scopeFieldsTried.join(', '),
          })),
        ],
        objectIdsFoundInVenue: objectIdsInVenue,
        usedDynamicDiscovery: dynamicResult.totalDocuments > 0 || objectIdsInVenue === 0,
        discoveredGraph: {
          venueDocument: venueDocumentPreview(salon),
          collections: discoveredPlain,
        },
      };

      bundle.debug = debugPayload;
      bundle.discoveredByCollection = dynamicResult.collections;

      console.log('[AI Knowledge Sync] ── Bundle summary ──');
      console.log(`  services: ${bundle.services.length}`);
      console.log(`  staff: ${bundle.staff.length}`);
      console.log(`  customers: ${bundle.customers.length}`);
      console.log(`  products: ${bundle.products.length}`);
      console.log(`  memberships: ${bundle.memberships.length}`);
      console.log(`  vouchers: ${bundle.vouchers.length}`);
      console.log(`  packages: ${bundle.packages.length}`);
      console.log(`  bookings: ${bundle.bookings.length}`);
      console.log(`  discovered collections: ${Object.keys(discoveredPlain).length}`);

      return bundle;
    });
  }
}
