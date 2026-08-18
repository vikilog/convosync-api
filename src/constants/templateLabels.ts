/** ConvoSync canonical template labels (DB + API). Meta values map into these. */

export const TEMPLATE_CATEGORIES = ['Utility', 'Marketing', 'Authentication'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

const META_STATUS_TO_SYSTEM: Record<string, TemplateStatus> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
};

const META_CATEGORY_TO_SYSTEM: Record<string, TemplateCategory> = {
  UTILITY: 'Utility',
  MARKETING: 'Marketing',
  AUTHENTICATION: 'Authentication',
};

const SYSTEM_CATEGORY_TO_META: Record<TemplateCategory, string> = {
  Utility: 'UTILITY',
  Marketing: 'MARKETING',
  Authentication: 'AUTHENTICATION',
};

export function metaStatusToSystem(status: string): TemplateStatus {
  const key = status.trim().toUpperCase();
  const mapped = META_STATUS_TO_SYSTEM[key];
  if (!mapped) {
    // Meta has added new template lifecycle states before — falling back to
    // 'pending' is a safe default, but do it loudly so an unmapped status
    // shows up in logs instead of silently masquerading as a known one.
    console.warn('[templates] unmapped Meta template status', { status });
    return 'pending';
  }
  return mapped;
}

export function metaCategoryToSystem(category: string): TemplateCategory {
  const key = category.trim().toUpperCase();
  return META_CATEGORY_TO_SYSTEM[key] ?? 'Utility';
}

export function systemCategoryToMeta(category: string): string {
  const normalized = metaCategoryToSystem(category);
  return SYSTEM_CATEGORY_TO_META[normalized];
}

export function isApprovedStatus(status: string): boolean {
  return status.toLowerCase() === 'approved';
}
