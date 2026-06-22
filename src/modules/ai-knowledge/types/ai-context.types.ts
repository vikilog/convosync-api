import type {
  NormalizedFaq,
  NormalizedMembership,
  NormalizedPolicy,
  NormalizedProduct,
  NormalizedService,
  NormalizedStaff,
  NormalizedVoucher,
  SalonProfile,
} from './normalized.types.js';

/** Context sections exposed to the AI receptionist / LLM pipeline. */
export type AiContextSectionKey =
  | 'salon'
  | 'services'
  | 'staff'
  | 'memberships'
  | 'vouchers'
  | 'products'
  | 'policies'
  | 'faqs';

/** Full knowledge split into AI-facing sections (loaded from ai_knowledge.data). */
export type AiKnowledgeSections = {
  salon: SalonProfile;
  services: NormalizedService[];
  staff: NormalizedStaff[];
  memberships: NormalizedMembership[];
  vouchers: NormalizedVoucher[];
  products: NormalizedProduct[];
  policies: NormalizedPolicy[];
  faqs: NormalizedFaq[];
};

/** Subset of salon profile for general queries (no working hours). */
export type SalonProfileSlice = Pick<
  SalonProfile,
  'name' | 'phone' | 'email' | 'address' | 'timezone' | 'currency'
>;

/** Subset of salon profile returned for hours-related queries. */
export type SalonHoursSlice = Pick<SalonProfile, 'name' | 'phone' | 'timezone' | 'workingHours'>;

/** Partial context payload — only matched sections are included. */
export type AiContextPayload = {
  salon?: SalonProfile | SalonProfileSlice | SalonHoursSlice;
  services?: NormalizedService[];
  staff?: NormalizedStaff[];
  memberships?: NormalizedMembership[];
  vouchers?: NormalizedVoucher[];
  products?: NormalizedProduct[];
  policies?: NormalizedPolicy[];
  faqs?: NormalizedFaq[];
};

export type AiContextStatus = 'ready' | 'not_synced' | 'sync_failed' | 'empty';

/** Output of getContextForQuery — structured + LLM-ready text block. */
export type AiContextResult = {
  venueId: string;
  query: string;
  matchedSections: AiContextSectionKey[];
  /** Structured subset of knowledge for programmatic use. */
  context: AiContextPayload;
  /** Plain-text block suitable for LLM system/user context injection. */
  promptContext: string;
  status: AiContextStatus;
  syncedAt: string | null;
};
