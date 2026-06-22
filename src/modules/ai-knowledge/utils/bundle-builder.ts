import type { Document } from 'mongodb';
import type { RawMongoBundle } from '../services/mongo-sync.service.js';
import { mergeAnyCollectionsIntoBundle } from './merge-resolved-docs.js';

export function createEmptyRawBundle(): RawMongoBundle {
  return {
    discoveredCollections: [],
    salon: null,
    services: [],
    staff: [],
    customers: [],
    memberships: [],
    packages: [],
    vouchers: [],
    products: [],
    faqs: [],
    policies: [],
    branches: [],
    serviceCategories: [],
    businessSettings: null,
    bookings: [],
  };
}

export function rebuildBundleFromCollections(
  collections: Record<string, unknown[]>
): RawMongoBundle {
  const docsByCollection: Record<string, Document[]> = {};
  for (const [name, docs] of Object.entries(collections)) {
    docsByCollection[name] = docs as Document[];
  }
  return mergeAnyCollectionsIntoBundle(createEmptyRawBundle(), docsByCollection);
}

/** Business-relevant collections first, then alphabetical. */
const COLLECTION_PRIORITY = [
  'Venue',
  'Service',
  'Staff',
  'ServicingStaff',
  'Client',
  'Product',
  'Appointment',
  'ServiceSubCategory',
  'ProductCategory',
  'Membership',
  'Package',
  'Voucher',
  'Offer',
  'Branch',
  'Setting',
  'BusinessSetting',
  'FAQ',
  'Policy',
];

export function sortCollectionsForSync(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ai = COLLECTION_PRIORITY.findIndex((p) => p.toLowerCase() === a.toLowerCase());
    const bi = COLLECTION_PRIORITY.findIndex((p) => p.toLowerCase() === b.toLowerCase());
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
}
