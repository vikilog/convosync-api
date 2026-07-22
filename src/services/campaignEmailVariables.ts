type CampaignContact = {
  name: string;
  email: string | null;
  phone: string;
  customFields?: unknown;
};

const CONTACT_RESOLVERS: Record<string, (contact: CampaignContact) => string> = {
  first_name: (c) => c.name.trim().split(/\s+/)[0] ?? '',
  last_name: (c) => c.name.trim().split(/\s+/).slice(1).join(' '),
  name: (c) => c.name.trim(),
  email: (c) => c.email?.trim() ?? '',
  phone: (c) => c.phone.trim(),
  'contact.name': (c) => c.name.trim(),
  'contact.first_name': (c) => c.name.trim().split(/\s+/)[0] ?? '',
  'contact.last_name': (c) => c.name.trim().split(/\s+/).slice(1).join(' '),
  'contact.email': (c) => c.email?.trim() ?? '',
  'contact.phone': (c) => c.phone.trim(),
};

export const CONTACT_AUTO_EMAIL_VARIABLES = new Set(Object.keys(CONTACT_RESOLVERS));

function readCustomField(customFields: unknown, key: string): string {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
    return '';
  }
  const value = (customFields as Record<string, unknown>)[key];
  if (value == null) return '';
  return String(value).trim();
}

function resolveFieldKey(contact: CampaignContact, key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (CONTACT_RESOLVERS[trimmed]) return CONTACT_RESOLVERS[trimmed](contact);
  if (trimmed.startsWith('contact.')) {
    return readCustomField(contact.customFields, trimmed.slice('contact.'.length));
  }
  if (trimmed.startsWith('custom.')) {
    return readCustomField(contact.customFields, trimmed.slice('custom.'.length));
  }
  return readCustomField(contact.customFields, trimmed);
}

/** Resolve `{{contact.name}}` (and friends) inside a mapping / template string. */
export function interpolateContactTokens(template: string, contact: CampaignContact): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawKey: string) =>
    resolveFieldKey(contact, rawKey)
  );
}

/**
 * Mapping value → concrete string for one contact.
 * - `{{contact.name}}` / mixed strings with tokens → interpolated
 * - bare `contact.name` / `name` → contact field
 * - anything else → static literal
 */
export function resolveMappingValue(mapped: string, contact: CampaignContact): string {
  const trimmed = mapped.trim();
  if (!trimmed) return '';
  if (trimmed.includes('{{')) return interpolateContactTokens(trimmed, contact);
  if (CONTACT_RESOLVERS[trimmed]) return CONTACT_RESOLVERS[trimmed](contact);
  return trimmed;
}

/** WhatsApp body params for one recipient (positional {{1}}..{{n}}). */
export function buildCampaignBodyParams(
  variableNames: string[],
  mappings: Record<string, string>,
  contact: CampaignContact
): string[] {
  return variableNames.map((name) => {
    const mapped = mappings[name]?.trim() ?? '';
    if (mapped) return resolveMappingValue(mapped, contact);
    // Variable label itself is a contact field (e.g. variables: ["contact.name"])
    if (CONTACT_RESOLVERS[name]) return CONTACT_RESOLVERS[name](contact);
    return '';
  });
}

/** Merge campaign-level mappings with per-contact fields. */
export function resolveCampaignEmailVariables(
  contact: CampaignContact,
  mappings: Record<string, string>,
  variableNames: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of variableNames) {
    const mapped = mappings[key]?.trim();
    if (mapped) {
      out[key] = resolveMappingValue(mapped, contact);
      continue;
    }
    const fromContact = resolveFieldKey(contact, key);
    if (fromContact) {
      out[key] = fromContact;
      continue;
    }
    out[key] = '';
  }
  return out;
}

export function emailVariableRequiresManualValue(varName: string): boolean {
  return !CONTACT_AUTO_EMAIL_VARIABLES.has(varName);
}
