import { normalizeWhatsAppContactPhone } from '../lib/whatsappContact.js';

export const CRM_CONTACT_TAGS = ['signup', 'convosync-client'] as const;

export type OrgCrmContactInput = {
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  ownerJobTitle?: string | null;
  workspaceId: string;
  workspaceName?: string | null;
  workspaceEmail?: string | null;
  workspacePhone?: string | null;
  country?: string | null;
  industry?: string | null;
  website?: string | null;
  companySize?: string | null;
};

/** Digits-only phone for Contact.phone (WhatsApp-ready). Prefer owner, then company. */
export function resolveCrmContactPhone(input: OrgCrmContactInput): string | null {
  for (const raw of [input.ownerPhone, input.workspacePhone]) {
    if (!raw?.trim()) continue;
    const digits = normalizeWhatsAppContactPhone(raw);
    if (digits.length >= 5) return digits;
  }
  return null;
}

export function buildCrmContactPayload(input: OrgCrmContactInput) {
  const phone = resolveCrmContactPhone(input);
  const email =
    input.ownerEmail?.trim() || input.workspaceEmail?.trim() || null;
  const name =
    input.ownerName?.trim() ||
    input.workspaceName?.trim() ||
    email ||
    'ConvoSync client';

  const customFields: Record<string, string> = {
    tenantWorkspaceId: input.workspaceId,
  };
  if (input.workspaceName?.trim()) customFields.companyName = input.workspaceName.trim();
  if (input.country?.trim()) customFields.country = input.country.trim();
  if (input.ownerJobTitle?.trim()) customFields.jobTitle = input.ownerJobTitle.trim();
  if (input.industry?.trim()) customFields.industry = input.industry.trim();
  if (input.website?.trim()) customFields.website = input.website.trim();
  if (input.companySize?.trim()) customFields.companySize = input.companySize.trim();

  return {
    name,
    phone,
    email: email || '',
    tags: [...CRM_CONTACT_TAGS],
    customFields,
    source: 'platform-signup',
  };
}

export function mergeContactTags(existing: string[], next: string[]): string[] {
  return [...new Set([...existing, ...next].map((t) => t.trim()).filter(Boolean))];
}

export function mergeCustomFields(
  existing: unknown,
  next: Record<string, string>
): Record<string, string> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return { ...out, ...next };
}
