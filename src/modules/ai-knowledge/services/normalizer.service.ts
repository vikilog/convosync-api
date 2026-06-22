import type { Document } from 'mongodb';
import type { RawMongoBundle } from './mongo-sync.service.js';
import type {
  BusinessSettings,
  CustomerSummary,
  NormalizedBranch,
  NormalizedFaq,
  NormalizedMembership,
  NormalizedPackage,
  NormalizedPolicy,
  NormalizedProduct,
  NormalizedSalonKnowledge,
  NormalizedService,
  NormalizedServiceCategory,
  NormalizedStaff,
  NormalizedVoucher,
  SalonProfile,
} from '../types/normalized.types.js';
import {
  asNumber,
  asString,
  asStringArray,
  docId,
  pickFirst,
  toIsoDate,
} from '../utils/field-utils.js';

function mapOperatingDays(days: unknown): unknown[] | Record<string, unknown> {
  if (!Array.isArray(days) || days.length === 0) return {};
  return days.map((entry) => {
    const d = (entry ?? {}) as Record<string, unknown>;
    return {
      day: asString(d.day),
      isOpen: d.isOpen === true,
      open: asString(d.open),
      close: asString(d.close),
      open24Hours: d.open24Hours === true,
      offPeakHours: Array.isArray(d.offPeakHours) ? d.offPeakHours : [],
    };
  });
}

function mapSalonProfile(raw: Document | null, venueId: string): SalonProfile {
  const doc = (raw ?? {}) as Record<string, unknown>;
  const addressObj = doc.address;
  const addressFromObject =
    addressObj && typeof addressObj === 'object' && !Array.isArray(addressObj)
      ? [
          asString((addressObj as Record<string, unknown>).formattedAddress),
          asString((addressObj as Record<string, unknown>).address1),
          asString((addressObj as Record<string, unknown>).city),
          asString((addressObj as Record<string, unknown>).region),
          asString((addressObj as Record<string, unknown>).postalCode),
          asString((addressObj as Record<string, unknown>).country),
        ]
      : [];

  const addressParts = [
    ...addressFromObject,
    pickFirst(doc, ['address', 'fullAddress', 'street']),
    pickFirst(doc, ['city']),
    pickFirst(doc, ['state', 'region']),
    pickFirst(doc, ['postalCode', 'zip', 'pincode']),
    pickFirst(doc, ['country']),
  ]
    .map((p) => asString(p))
    .filter(Boolean);

  const operatingDays = mapOperatingDays(doc.operatingDays);
  const legacyHours = pickFirst(doc, ['workingHours', 'businessHours', 'hours', 'openingHours']);

  return {
    name: asString(pickFirst(doc, ['name', 'salonName', 'businessName', 'title'])) || venueId,
    phone: asString(pickFirst(doc, ['phone', 'phoneNumber', 'mobile', 'contactPhone'])),
    email: asString(pickFirst(doc, ['email', 'contactEmail', 'businessEmail'])),
    address: [...new Set(addressParts)].join(', '),
    timezone: asString(pickFirst(doc, ['timezone', 'timeZone'], 'Asia/Kolkata')),
    currency: asString(pickFirst(doc, ['currency', 'currencyCode'], 'INR')),
    workingHours:
      (Array.isArray(operatingDays) && operatingDays.length > 0
        ? operatingDays
        : (legacyHours as Record<string, unknown> | unknown[])) ?? {},
  };
}

function mapService(doc: Document): NormalizedService {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    name: asString(pickFirst(d, ['name', 'title', 'serviceName'])),
    description: asString(pickFirst(d, ['description', 'details', 'summary'])),
    category: asString(
      pickFirst(d, ['category', 'categoryName', 'serviceCategory', 'type'], 'General')
    ),
    duration: asNumber(pickFirst(d, ['duration', 'durationMinutes', 'durationMins', 'time'])),
    price: asNumber(
      pickFirst(d, ['price', 'amount', 'cost', 'basePrice', 'onlinePrice', 'walkInPrice'])
    ),
  };
}

function mapStaff(doc: Document): NormalizedStaff {
  const d = doc as Record<string, unknown>;
  const first = asString(pickFirst(d, ['firstName', 'first_name']));
  const last = asString(pickFirst(d, ['lastName', 'last_name']));
  const fullName =
    asString(pickFirst(d, ['name', 'fullName', 'displayName'])) ||
    [first, last].filter(Boolean).join(' ');

  return {
    id: docId(d),
    name: fullName,
    role: asString(pickFirst(d, ['role', 'title', 'designation', 'jobTitle'], 'Staff')),
    experience: asString(pickFirst(d, ['experience', 'yearsOfExperience', 'experienceYears'])),
    skills: asStringArray(
      pickFirst(d, ['skills', 'specialties', 'services', 'expertise', 'specialization'])
    ),
  };
}

function mapCustomerSummary(doc: Document): CustomerSummary {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    name: asString(pickFirst(d, ['name', 'fullName', 'customerName'])),
    totalSpent: asNumber(
      pickFirst(d, ['totalSpent', 'lifetimeValue', 'totalSpend', 'ltv'])
    ),
    favoriteServices: asStringArray(
      pickFirst(d, ['favoriteServices', 'preferredServices', 'topServices'])
    ),
    visitCount: asNumber(pickFirst(d, ['visitCount', 'visits', 'totalVisits', 'appointments'])),
    lastVisit: toIsoDate(pickFirst(d, ['lastVisit', 'lastVisitAt', 'lastAppointment'])),
  };
}

function mapMembership(doc: Document): NormalizedMembership {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    name: asString(pickFirst(d, ['name', 'title', 'planName'])),
    description: asString(pickFirst(d, ['description', 'details'])),
    price: asNumber(pickFirst(d, ['price', 'amount', 'cost'])),
    durationDays: asNumber(pickFirst(d, ['durationDays', 'validityDays', 'duration'])) || null,
    benefits: asStringArray(pickFirst(d, ['benefits', 'features', 'perks'])),
  };
}

function mapPackage(doc: Document): NormalizedPackage {
  const d = doc as Record<string, unknown>;
  const serviceIdsRaw = pickFirst(d, ['serviceIds', 'services', 'includedServices']);
  const serviceIds = Array.isArray(serviceIdsRaw)
    ? serviceIdsRaw.map((id) => asString(id)).filter(Boolean)
    : asStringArray(serviceIdsRaw);

  return {
    id: docId(d),
    name: asString(pickFirst(d, ['name', 'title', 'packageName'])),
    description: asString(pickFirst(d, ['description', 'details'])),
    price: asNumber(pickFirst(d, ['price', 'amount', 'cost', 'packagePrice'])),
    serviceIds,
    benefits: asStringArray(pickFirst(d, ['benefits', 'features', 'perks', 'includes'])),
  };
}

function mapVoucher(doc: Document): NormalizedVoucher {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    code: asString(pickFirst(d, ['code', 'voucherCode', 'couponCode'])),
    name: asString(pickFirst(d, ['name', 'title', 'label'])),
    discountType: asString(pickFirst(d, ['discountType', 'type'], 'fixed')),
    discountValue: asNumber(pickFirst(d, ['discountValue', 'discount', 'amount', 'value'])),
    validUntil: toIsoDate(pickFirst(d, ['validUntil', 'expiresAt', 'expiryDate'])),
  };
}

function mapProduct(doc: Document): NormalizedProduct {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    name: asString(pickFirst(d, ['name', 'title', 'productName'])),
    description: asString(pickFirst(d, ['description', 'details'])),
    category: asString(pickFirst(d, ['category', 'categoryName'], 'General')),
    price: asNumber(pickFirst(d, ['price', 'amount', 'retailPrice'])),
    stock: asNumber(pickFirst(d, ['stock', 'quantity', 'inventory'])) || null,
  };
}

function mapFaq(doc: Document): NormalizedFaq {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    question: asString(pickFirst(d, ['question', 'title', 'q'])),
    answer: asString(pickFirst(d, ['answer', 'content', 'body', 'a'])),
    category: asString(pickFirst(d, ['category', 'topic'], 'General')),
  };
}

function mapPolicy(doc: Document): NormalizedPolicy {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    title: asString(pickFirst(d, ['title', 'name', 'policyName'])),
    content: asString(pickFirst(d, ['content', 'body', 'text', 'description'])),
    type: asString(pickFirst(d, ['type', 'policyType'], 'general')),
  };
}

function mapBranch(doc: Document): NormalizedBranch {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    name: asString(pickFirst(d, ['name', 'branchName', 'title'])),
    address: asString(pickFirst(d, ['address', 'fullAddress'])),
    phone: asString(pickFirst(d, ['phone', 'phoneNumber'])),
  };
}

function mapServiceCategory(doc: Document): NormalizedServiceCategory {
  const d = doc as Record<string, unknown>;
  return {
    id: docId(d),
    name: asString(pickFirst(d, ['name', 'title', 'categoryName'])),
    description: asString(pickFirst(d, ['description', 'details'])),
  };
}

function mapBusinessSettings(raw: Document | null): BusinessSettings {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    bookingLeadTimeMinutes:
      asNumber(pickFirst(d, ['bookingLeadTimeMinutes', 'leadTimeMinutes'])) || null,
    cancellationPolicy: asString(
      pickFirst(d, ['cancellationPolicy', 'cancelPolicy', 'cancellation'])
    ),
    depositRequired: Boolean(pickFirst(d, ['depositRequired', 'requiresDeposit'], false)),
    taxRate: asNumber(pickFirst(d, ['taxRate', 'gstRate', 'vatRate'])) || null,
    raw: d,
  };
}

/** Converts raw Mongo documents into a stable JSON shape for AI + vector pipelines. */
export class NormalizerService {
  normalize(venueId: string, raw: RawMongoBundle): NormalizedSalonKnowledge {
    const normalized: NormalizedSalonKnowledge = {
      salon: mapSalonProfile(raw.salon, venueId),
      services: raw.services.map(mapService).filter((s) => s.name || s.id),
      staff: raw.staff.map(mapStaff).filter((s) => s.name || s.id),
      memberships: raw.memberships.map(mapMembership).filter((m) => m.name || m.id),
      packages: raw.packages.map(mapPackage).filter((p) => p.name || p.id),
      vouchers: raw.vouchers.map(mapVoucher).filter((v) => v.code || v.name || v.id),
      products: raw.products.map(mapProduct).filter((p) => p.name || p.id),
      faqs: raw.faqs.map(mapFaq).filter((f) => f.question || f.answer),
      policies: raw.policies.map(mapPolicy).filter((p) => p.title || p.content),
      branches: raw.branches.map(mapBranch).filter((b) => b.name || b.id),
      serviceCategories: raw.serviceCategories
        .map(mapServiceCategory)
        .filter((c) => c.name || c.id),
      businessSettings: mapBusinessSettings(raw.businessSettings),
      customersSummary: raw.customers
        .map(mapCustomerSummary)
        .filter((c) => c.name || c.id)
        .slice(0, 200),
    };

    if (raw.debug) {
      normalized.syncLogs = raw.debug.syncLogs;
      normalized.resolvedStats = {
        totalDocuments: raw.debug.discoveryLogs.reduce((n, l) => n + l.documentsFound, 0),
        totalDurationMs: raw.debug.discoveryLogs.reduce((n, l) => n + l.durationMs, 0),
        collectionsTouched: raw.debug.discoveryLogs.filter((l) => l.documentsFound > 0).length,
      };
    } else if (raw.resolvedGraph) {
      normalized.expandedVenue = raw.resolvedGraph.expandedRoot;
      normalized.syncLogs = raw.resolvedGraph.syncLogs;
      normalized.resolvedStats = raw.resolvedGraph.stats;
    }

    if (raw.resolvedGraph?.expandedRoot) {
      normalized.expandedVenue = raw.resolvedGraph.expandedRoot;
    }

    return normalized;
  }
}
