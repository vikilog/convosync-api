import type { Document } from 'mongodb';
import type { RawMongoBundle } from '../services/mongo-sync.service.js';
import { docId } from './field-utils.js';

/** Maps MongoDB collection names to RawMongoBundle array/single-doc keys. */
const COLLECTION_TO_BUNDLE: Record<string, keyof RawMongoBundle> = {
  services: 'services',
  Service: 'services',
  service: 'services',
  treatments: 'services',
  treatment: 'services',
  staff: 'staff',
  Staff: 'staff',
  ServicingStaff: 'staff',
  employees: 'staff',
  employee: 'staff',
  stylists: 'staff',
  team: 'staff',
  team_members: 'staff',
  customers: 'customers',
  Client: 'customers',
  customer: 'customers',
  clients: 'customers',
  client: 'customers',
  memberships: 'memberships',
  membership: 'memberships',
  membership_plans: 'memberships',
  plans: 'memberships',
  packages: 'packages',
  package: 'packages',
  bundles: 'packages',
  combos: 'packages',
  offers: 'packages',
  vouchers: 'vouchers',
  voucher: 'vouchers',
  coupons: 'vouchers',
  coupon: 'vouchers',
  gift_cards: 'vouchers',
  promo_codes: 'vouchers',
  products: 'products',
  Product: 'products',
  product: 'products',
  inventory: 'products',
  retail_products: 'products',
  faqs: 'faqs',
  faq: 'faqs',
  help_articles: 'faqs',
  questions: 'faqs',
  policies: 'policies',
  policy: 'policies',
  terms: 'policies',
  terms_and_conditions: 'policies',
  rules: 'policies',
  branches: 'branches',
  branch: 'branches',
  locations: 'branches',
  location: 'branches',
  stores: 'branches',
  service_categories: 'serviceCategories',
  serviceCategories: 'serviceCategories',
  categories: 'serviceCategories',
  category: 'serviceCategories',
  ServiceSubCategory: 'serviceCategories',
  ProductCategory: 'serviceCategories',
  service_types: 'serviceCategories',
  salons: 'salon',
  salon: 'salon',
  Venue: 'salon',
  venues: 'salon',
  venue: 'salon',
  businesses: 'salon',
  business: 'salon',
  settings: 'businessSettings',
  business_settings: 'businessSettings',
  businessSettings: 'businessSettings',
  configurations: 'businessSettings',
  config: 'businessSettings',
  bookings: 'bookings',
  booking: 'bookings',
  Appointment: 'bookings',
  appointments: 'bookings',
  appointment: 'bookings',
  reservations: 'bookings',
};

const SINGLE_DOC_KEYS = new Set<keyof RawMongoBundle>(['salon', 'businessSettings']);

function mergeArrayField(
  existing: Document[],
  incoming: Record<string, unknown>[]
): Document[] {
  const byId = new Map<string, Document>();
  for (const doc of existing) {
    const id = docId(doc as Record<string, unknown>);
    if (id) byId.set(id, doc);
  }
  for (const doc of incoming) {
    const id = docId(doc);
    if (id && !byId.has(id)) {
      byId.set(id, doc as Document);
    }
  }
  return [...byId.values()];
}

/**
 * Merges documents fetched by RecursiveResolverService into an existing RawMongoBundle.
 * Does not overwrite single-doc fields when already populated.
 */
export function mergeResolvedIntoBundle(
  bundle: RawMongoBundle,
  documentsByCollection: Record<string, Record<string, unknown>[]>
): RawMongoBundle {
  const next = { ...bundle };

  for (const [collectionName, docs] of Object.entries(documentsByCollection)) {
    const bundleKey = COLLECTION_TO_BUNDLE[collectionName];
    if (!bundleKey || docs.length === 0) continue;

    if (SINGLE_DOC_KEYS.has(bundleKey)) {
      const current = next[bundleKey] as Document | null;
      if (!current && docs[0]) {
        (next as Record<string, unknown>)[bundleKey] = docs[0] as Document;
      }
      continue;
    }

    const currentArr = (next[bundleKey] as Document[]) ?? [];
    (next as Record<string, unknown>)[bundleKey] = mergeArrayField(currentArr, docs);
  }

  return next;
}

/** Merges dynamically discovered collection documents into the typed bundle arrays. */
export function mergeAnyCollectionsIntoBundle(
  bundle: RawMongoBundle,
  documentsByCollection: Record<string, Document[]>
): RawMongoBundle {
  const plain: Record<string, Record<string, unknown>[]> = {};
  for (const [name, docs] of Object.entries(documentsByCollection)) {
    plain[name] = docs.map((d) => d as unknown as Record<string, unknown>);
  }
  return mergeResolvedIntoBundle(bundle, plain);
}

export function documentsToPlainCollections(
  documentsByCollection: Record<string, Document[]>
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [name, docs] of Object.entries(documentsByCollection)) {
    out[name] = docs.map((d) => JSON.parse(JSON.stringify(d)) as unknown);
  }
  return out;
}
