/** Candidate MongoDB collection names for salon systems (read-only discovery). */
export const COLLECTION_CANDIDATES = {
  salon: ['salons', 'salon', 'venues', 'venue', 'businesses', 'business', 'companies'],
  services: ['services', 'service', 'treatments', 'treatment', 'offerings'],
  staff: ['staff', 'employees', 'employee', 'stylists', 'team', 'team_members'],
  customers: ['customers', 'customer', 'clients', 'client', 'users'],
  memberships: ['memberships', 'membership', 'membership_plans', 'plans'],
  packages: ['packages', 'package', 'bundles', 'combos', 'offers'],
  vouchers: ['vouchers', 'voucher', 'coupons', 'coupon', 'gift_cards', 'promo_codes'],
  products: ['products', 'product', 'inventory', 'retail_products'],
  faqs: ['faqs', 'faq', 'help_articles', 'questions'],
  policies: ['policies', 'policy', 'terms', 'terms_and_conditions', 'rules'],
  branches: ['branches', 'branch', 'locations', 'location', 'stores'],
  serviceCategories: [
    'service_categories',
    'serviceCategories',
    'categories',
    'category',
    'service_types',
  ],
  businessSettings: ['settings', 'business_settings', 'businessSettings', 'configurations', 'config'],
} as const;

export type CollectionKey = keyof typeof COLLECTION_CANDIDATES;

/** Field names used to scope documents to a venue/salon. */
export const VENUE_ID_FIELDS = [
  'venueIds',
  'venueId',
  'venue_id',
  'venue',
  'salonIds',
  'salonId',
  'salon_id',
  'branchIds',
  'branchId',
  'branch_id',
  'locationIds',
  'locationId',
  'location_id',
  'businessIds',
  'businessId',
  'business_id',
  'partnerId',
  'partner_id',
] as const;
