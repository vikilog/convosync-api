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

export type SesProviderConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
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
};

export type ProviderConnectionTestResult = {
  ok: boolean;
  message: string;
};
