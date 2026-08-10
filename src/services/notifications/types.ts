/** Extensible in-app notification type constants (not DB enums). */
export const NOTIFICATION_TYPES = {
  TEMPLATE_APPROVED: 'template_approved',
  TEMPLATE_REJECTED: 'template_rejected',
  CAMPAIGN_COMPLETED: 'campaign_completed',
  CAMPAIGN_FAILED: 'campaign_failed',
  CONTACT_IMPORT_FINISHED: 'contact_import_finished',
  WALLET_BALANCE_LOW: 'wallet_balance_low',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

/** Extensible category buckets for filter tabs. */
export const NOTIFICATION_CATEGORIES = {
  CAMPAIGNS: 'campaigns',
  SYSTEM: 'system',
  IMPORTS: 'imports',
} as const;

export type NotificationCategory =
  (typeof NOTIFICATION_CATEGORIES)[keyof typeof NOTIFICATION_CATEGORIES];

export type NotificationSeverity = 'success' | 'failure' | 'info' | 'warning';

const TYPE_CATEGORY: Record<string, NotificationCategory> = {
  [NOTIFICATION_TYPES.TEMPLATE_APPROVED]: NOTIFICATION_CATEGORIES.SYSTEM,
  [NOTIFICATION_TYPES.TEMPLATE_REJECTED]: NOTIFICATION_CATEGORIES.SYSTEM,
  [NOTIFICATION_TYPES.CAMPAIGN_COMPLETED]: NOTIFICATION_CATEGORIES.CAMPAIGNS,
  [NOTIFICATION_TYPES.CAMPAIGN_FAILED]: NOTIFICATION_CATEGORIES.CAMPAIGNS,
  [NOTIFICATION_TYPES.CONTACT_IMPORT_FINISHED]: NOTIFICATION_CATEGORIES.IMPORTS,
  [NOTIFICATION_TYPES.WALLET_BALANCE_LOW]: NOTIFICATION_CATEGORIES.SYSTEM,
};

const TYPE_SEVERITY: Record<string, NotificationSeverity> = {
  [NOTIFICATION_TYPES.TEMPLATE_APPROVED]: 'success',
  [NOTIFICATION_TYPES.TEMPLATE_REJECTED]: 'failure',
  [NOTIFICATION_TYPES.CAMPAIGN_COMPLETED]: 'success',
  [NOTIFICATION_TYPES.CAMPAIGN_FAILED]: 'failure',
  [NOTIFICATION_TYPES.CONTACT_IMPORT_FINISHED]: 'info',
  [NOTIFICATION_TYPES.WALLET_BALANCE_LOW]: 'warning',
};

export function categoryForType(type: string): NotificationCategory {
  return TYPE_CATEGORY[type] ?? NOTIFICATION_CATEGORIES.SYSTEM;
}

export function severityForType(type: string): NotificationSeverity {
  return TYPE_SEVERITY[type] ?? 'info';
}
