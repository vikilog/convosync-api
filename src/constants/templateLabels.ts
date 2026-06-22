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
  return META_STATUS_TO_SYSTEM[key] ?? 'pending';
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
