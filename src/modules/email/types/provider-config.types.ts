import type { SesVerifiedIdentity } from '../utils/ses-verified-identities.js';

/** Stored provider types for BYOP configuration. */
export const EMAIL_PROVIDER_CONFIG_TYPES = [
  'CONVOSYNC_MANAGED',
  'RESEND',
  'AWS_SES',
  'SENDGRID',
  'SMTP',
] as const;

export type EmailProviderConfigType = (typeof EMAIL_PROVIDER_CONFIG_TYPES)[number];

/** Legacy rows may still use `WABIZ_MANAGED` in the database. */
export function normalizeEmailProviderType(provider: string): EmailProviderConfigType {
  if (provider === 'WABIZ_MANAGED') return 'CONVOSYNC_MANAGED';
  return provider as EmailProviderConfigType;
}

/** Platform email (CONVOSYNC_MANAGED): bill wallet CC only — never emailsLimit / plan quota. */
export function usesPlatformEmailMetering(provider: string): boolean {
  return normalizeEmailProviderType(provider) === 'CONVOSYNC_MANAGED';
}

export const EMAIL_PROVIDER_CONFIG_STATUSES = [
  'active',
  'disabled',
  'credentials_missing',
  'connection_failed',
] as const;

export type EmailProviderConfigStatus = (typeof EMAIL_PROVIDER_CONFIG_STATUSES)[number];

export type ResendProviderConfig = {
  apiKey: string;
};

export type SesTrackingStatus = 'enabled' | 'error' | 'disabled';

export type SesProviderConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Default From for transactional/alert sends (must match a verified identity). */
  senderEmail?: string;
  verifiedIdentities?: SesVerifiedIdentity[];
  identitiesFetchedAt?: string | null;
  /** SES configuration set used for open/click/bounce event publishing. */
  configurationSetName?: string;
  snsTopicArn?: string;
  trackingStatus?: SesTrackingStatus;
  /** Human-readable IAM / setup failure (safe to show in UI). */
  trackingError?: string | null;
};

export type SendGridProviderConfig = {
  apiKey: string;
};

export type SmtpProviderConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
};

export type ProviderConfigPayload =
  | ResendProviderConfig
  | SesProviderConfig
  | SendGridProviderConfig
  | SmtpProviderConfig
  | Record<string, never>;

export type EmailProviderConfigPublic = {
  id: string;
  workspaceId: string;
  provider: EmailProviderConfigType;
  isDefault: boolean;
  status: EmailProviderConfigStatus;
  hasCredentials: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Present for AWS_SES only (non-secret metadata for the edit form). */
  region?: string | null;
  senderEmail?: string | null;
  accessKeyIdMasked?: string | null;
  verifiedIdentities?: SesVerifiedIdentity[];
  identitiesFetchedAt?: string | null;
  sesConsoleUrl?: string | null;
  trackingStatus?: SesTrackingStatus | null;
  trackingError?: string | null;
  configurationSetName?: string | null;
};

export type ProviderConnectionTestResult = {
  ok: boolean;
  message: string;
};
