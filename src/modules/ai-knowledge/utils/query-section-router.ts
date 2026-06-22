import type { AiContextSectionKey } from '../types/ai-context.types.js';

export type SalonContextMode = 'none' | 'profile' | 'workingHours';

export type QuerySectionResolution = {
  sections: AiContextSectionKey[];
  salonMode: SalonContextMode;
};

type SectionRule = {
  section: AiContextSectionKey;
  keywords: string[];
  salonMode?: SalonContextMode;
};

const SECTION_RULES: SectionRule[] = [
  {
    section: 'services',
    keywords: [
      'price',
      'service',
      'duration',
      'haircut',
      'hair',
      'trim',
      'cut',
      'treatment',
      'book',
      'booking',
      'appointment',
    ],
  },
  { section: 'staff', keywords: ['staff', 'stylist', 'barber'] },
  { section: 'memberships', keywords: ['membership'] },
  { section: 'vouchers', keywords: ['voucher', 'offer', 'discount', 'coupon'] },
  {
    section: 'salon',
    keywords: ['timing', 'open', 'hours', 'tomorrow', 'today', 'book', 'booking', 'appointment', 'schedule'],
    salonMode: 'workingHours',
  },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryMatchesKeyword(query: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegex(keyword)}s?\\b`, 'i');
  return pattern.test(query);
}

function queryMatchesAny(query: string, keywords: string[]): boolean {
  return keywords.some((keyword) => queryMatchesKeyword(query, keyword));
}

/**
 * Maps a user query to the knowledge sections that should be loaded.
 * When no rule matches, defaults to a minimal salon profile for general queries.
 */
export function resolveSectionsForQuery(query: string): QuerySectionResolution {
  const trimmed = query.trim();
  if (!trimmed) {
    return { sections: ['salon'], salonMode: 'profile' };
  }

  const matched = new Set<AiContextSectionKey>();
  let salonMode: SalonContextMode = 'none';

  for (const rule of SECTION_RULES) {
    if (!queryMatchesAny(trimmed, rule.keywords)) continue;
    matched.add(rule.section);
    if (rule.section === 'salon' && rule.salonMode) {
      salonMode = rule.salonMode;
    }
  }

  if (matched.size === 0) {
    return { sections: ['salon'], salonMode: 'profile' };
  }

  const sections = [...matched];
  if (salonMode === 'none' && sections.includes('salon')) {
    salonMode = 'profile';
  }

  return { sections, salonMode };
}
