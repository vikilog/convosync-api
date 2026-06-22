import type {
  AiContextPayload,
  AiContextSectionKey,
  AiKnowledgeSections,
  SalonHoursSlice,
  SalonProfileSlice,
} from '../types/ai-context.types.js';
import type { SalonContextMode } from './query-section-router.js';
import type { NormalizedSalonKnowledge, SalonProfile } from '../types/normalized.types.js';

const EMPTY_SECTIONS: AiKnowledgeSections = {
  salon: {
    name: '',
    phone: '',
    email: '',
    address: '',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    workingHours: {},
  },
  services: [],
  staff: [],
  memberships: [],
  vouchers: [],
  products: [],
  policies: [],
  faqs: [],
};

export function knowledgeToSections(data: unknown): AiKnowledgeSections {
  const raw = (data ?? {}) as Partial<NormalizedSalonKnowledge>;
  return {
    salon: { ...EMPTY_SECTIONS.salon, ...(raw.salon ?? {}) },
    services: raw.services ?? [],
    staff: raw.staff ?? [],
    memberships: raw.memberships ?? [],
    vouchers: raw.vouchers ?? [],
    products: raw.products ?? [],
    policies: raw.policies ?? [],
    faqs: raw.faqs ?? [],
  };
}

function salonProfileSlice(salon: AiKnowledgeSections['salon']): SalonProfileSlice {
  return {
    name: salon.name,
    phone: salon.phone,
    email: salon.email,
    address: salon.address,
    timezone: salon.timezone,
    currency: salon.currency,
  };
}

function salonWorkingHoursSlice(salon: AiKnowledgeSections['salon']): SalonHoursSlice {
  return {
    name: salon.name,
    phone: salon.phone,
    timezone: salon.timezone,
    workingHours: salon.workingHours,
  };
}

export function buildContextPayload(
  sections: AiContextSectionKey[],
  knowledge: AiKnowledgeSections,
  salonMode: SalonContextMode
): AiContextPayload {
  const payload: AiContextPayload = {};

  if (sections.includes('salon')) {
    if (salonMode === 'workingHours') {
      payload.salon = salonWorkingHoursSlice(knowledge.salon);
    } else if (salonMode === 'profile') {
      payload.salon = salonProfileSlice(knowledge.salon);
    } else {
      payload.salon = knowledge.salon;
    }
  }

  if (sections.includes('services')) payload.services = knowledge.services;
  if (sections.includes('staff')) payload.staff = knowledge.staff;
  if (sections.includes('memberships')) payload.memberships = knowledge.memberships;
  if (sections.includes('vouchers')) payload.vouchers = knowledge.vouchers;
  if (sections.includes('products')) payload.products = knowledge.products;
  if (sections.includes('policies')) payload.policies = knowledge.policies;
  if (sections.includes('faqs')) payload.faqs = knowledge.faqs;

  return payload;
}

function formatWorkingHours(workingHours: SalonProfile['workingHours']): string[] {
  if (Array.isArray(workingHours)) {
    return workingHours.map((entry) => {
      const day = (entry as Record<string, unknown>).day ?? 'Day';
      const isOpen = (entry as Record<string, unknown>).isOpen;
      if (isOpen === false) return `- ${day}: Closed`;
      const open = (entry as Record<string, unknown>).open ?? '?';
      const close = (entry as Record<string, unknown>).close ?? '?';
      const open24 = (entry as Record<string, unknown>).open24Hours === true;
      return open24
        ? `- ${day}: Open 24 hours`
        : `- ${day}: ${open} – ${close}`;
    });
  }
  if (workingHours && typeof workingHours === 'object') {
    return Object.entries(workingHours).map(([day, hours]) => `- ${day}: ${JSON.stringify(hours)}`);
  }
  return ['- No working hours on file'];
}

function formatSalonBlock(salon: AiContextPayload['salon']): string[] {
  if (!salon) return [];
  const lines = ['## Salon'];
  if (salon.name) lines.push(`Name: ${salon.name}`);
  if ('phone' in salon && salon.phone) lines.push(`Phone: ${salon.phone}`);
  if ('email' in salon && salon.email) lines.push(`Email: ${salon.email}`);
  if ('address' in salon && salon.address) lines.push(`Address: ${salon.address}`);
  if ('timezone' in salon && salon.timezone) lines.push(`Timezone: ${salon.timezone}`);
  if ('currency' in salon && salon.currency) lines.push(`Currency: ${salon.currency}`);
  if ('workingHours' in salon && salon.workingHours) {
    lines.push('Working hours:');
    lines.push(...formatWorkingHours(salon.workingHours));
  }
  return lines;
}

/** Builds a plain-text context block for LLM system/user message injection. */
export function formatContextForLlm(
  venueId: string,
  context: AiContextPayload,
  matchedSections: AiContextSectionKey[]
): string {
  const lines: string[] = [
    '# Salon knowledge context',
    `Venue ID: ${venueId}`,
    `Sections: ${matchedSections.join(', ')}`,
    '',
  ];

  lines.push(...formatSalonBlock(context.salon));
  if (context.salon) lines.push('');

  if (context.services?.length) {
    lines.push('## Services');
    for (const s of context.services) {
      lines.push(
        `- ${s.name} (${s.category}): ${s.duration} min, ${s.price}${s.description ? ` — ${s.description}` : ''}`
      );
    }
    lines.push('');
  }

  if (context.staff?.length) {
    lines.push('## Staff');
    for (const member of context.staff) {
      const skills = member.skills.length ? ` — ${member.skills.join(', ')}` : '';
      lines.push(`- ${member.name || 'Staff'} (${member.role})${skills}`);
    }
    lines.push('');
  }

  if (context.memberships?.length) {
    lines.push('## Memberships');
    for (const m of context.memberships) {
      lines.push(`- ${m.name}: ${m.price}${m.description ? ` — ${m.description}` : ''}`);
    }
    lines.push('');
  }

  if (context.vouchers?.length) {
    lines.push('## Vouchers & offers');
    for (const v of context.vouchers) {
      lines.push(`- ${v.name || v.code}: ${v.discountType} ${v.discountValue}`);
    }
    lines.push('');
  }

  if (context.products?.length) {
    lines.push('## Products');
    for (const p of context.products) {
      lines.push(`- ${p.name} (${p.category}): ${p.price}`);
    }
    lines.push('');
  }

  if (context.policies?.length) {
    lines.push('## Policies');
    for (const p of context.policies) {
      lines.push(`- ${p.title}: ${p.content}`);
    }
    lines.push('');
  }

  if (context.faqs?.length) {
    lines.push('## FAQs');
    for (const f of context.faqs) {
      lines.push(`Q: ${f.question}`);
      lines.push(`A: ${f.answer}`);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}
