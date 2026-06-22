import type { SyncLogEntry } from './sync-log.types.js';

/** Normalized knowledge payload consumed by AI receptionist + future vector DB. */

export type SalonProfile = {
  name: string;
  phone: string;
  email: string;
  address: string;
  timezone: string;
  currency: string;
  workingHours: Record<string, unknown> | unknown[];
};

export type NormalizedService = {
  id: string;
  name: string;
  description: string;
  category: string;
  duration: number;
  price: number;
};

export type NormalizedStaff = {
  id: string;
  name: string;
  role: string;
  experience: string;
  skills: string[];
};

export type CustomerSummary = {
  id: string;
  name: string;
  totalSpent: number;
  favoriteServices: string[];
  visitCount: number;
  lastVisit: string | null;
};

export type NormalizedMembership = {
  id: string;
  name: string;
  description: string;
  price: number;
  durationDays: number | null;
  benefits: string[];
};

export type NormalizedPackage = {
  id: string;
  name: string;
  description: string;
  price: number;
  serviceIds: string[];
  benefits: string[];
};

export type NormalizedVoucher = {
  id: string;
  code: string;
  name: string;
  discountType: string;
  discountValue: number;
  validUntil: string | null;
};

export type NormalizedProduct = {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  stock: number | null;
};

export type NormalizedFaq = {
  id: string;
  question: string;
  answer: string;
  category: string;
};

export type NormalizedPolicy = {
  id: string;
  title: string;
  content: string;
  type: string;
};

export type NormalizedBranch = {
  id: string;
  name: string;
  address: string;
  phone: string;
};

export type NormalizedServiceCategory = {
  id: string;
  name: string;
  description: string;
};

export type BusinessSettings = {
  bookingLeadTimeMinutes: number | null;
  cancellationPolicy: string;
  depositRequired: boolean;
  taxRate: number | null;
  raw: Record<string, unknown>;
};

export type NormalizedSalonKnowledge = {
  salon: SalonProfile;
  services: NormalizedService[];
  staff: NormalizedStaff[];
  memberships: NormalizedMembership[];
  packages: NormalizedPackage[];
  vouchers: NormalizedVoucher[];
  products: NormalizedProduct[];
  faqs: NormalizedFaq[];
  policies: NormalizedPolicy[];
  branches: NormalizedBranch[];
  serviceCategories: NormalizedServiceCategory[];
  businessSettings: BusinessSettings;
  customersSummary: CustomerSummary[];
  /** Venue document with all ObjectId references recursively expanded. */
  expandedVenue?: Record<string, unknown>;
  /** Per-collection fetch logs from recursive resolution. */
  syncLogs?: SyncLogEntry[];
  resolvedStats?: {
    totalDocuments: number;
    totalDurationMs: number;
    collectionsTouched: number;
  };
};

/** Chunk ready for embedding — populated in a future pipeline. */
export type KnowledgeChunk = {
  id: string;
  sourceType: string;
  sourceId: string;
  text: string;
  metadata: Record<string, unknown>;
};
