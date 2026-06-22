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
};

export const CONTACT_AUTO_EMAIL_VARIABLES = new Set(Object.keys(CONTACT_RESOLVERS));

function readCustomField(customFields: unknown, key: string): string {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
    return '';
  }
  const value = (customFields as Record<string, unknown>)[key];
  if (value == null) return '';
  const text = String(value).trim();
  return text;
}

/** Merge campaign-level mappings with per-contact fields (contact wins when mapping empty). */
export function resolveCampaignEmailVariables(
  contact: CampaignContact,
  mappings: Record<string, string>,
  variableNames: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of variableNames) {
    const mapped = mappings[key]?.trim();
    if (mapped) {
      out[key] = mapped;
      continue;
    }
    if (CONTACT_RESOLVERS[key]) {
      out[key] = CONTACT_RESOLVERS[key](contact);
      continue;
    }
    const custom = readCustomField(contact.customFields, key);
    if (custom) {
      out[key] = custom;
      continue;
    }
    out[key] = '';
  }
  return out;
}

export function emailVariableRequiresManualValue(varName: string): boolean {
  return !CONTACT_AUTO_EMAIL_VARIABLES.has(varName);
}
