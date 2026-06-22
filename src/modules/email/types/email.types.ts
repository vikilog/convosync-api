/** Supported outbound email providers (extensible). */
export const EMAIL_PROVIDERS = ['resend', 'ses', 'sendgrid', 'smtp'] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

export const EMAIL_DOMAIN_STATUSES = ['pending', 'verified', 'failed'] as const;
export type EmailDomainStatus = (typeof EMAIL_DOMAIN_STATUSES)[number];

export const EMAIL_LOG_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'failed',
] as const;
export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number];

export type DnsRecordType = 'SPF' | 'DKIM' | 'DMARC' | 'MX' | 'TXT' | 'CNAME';

export type DnsRecord = {
  type: DnsRecordType;
  name: string;
  value: string;
  status?: 'pending' | 'verified' | 'failed';
};

export type SendEmailInput = {
  from: string;
  fromName?: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  tags?: Record<string, string>;
};

export type SendEmailResult = {
  messageId: string;
  provider: EmailProviderName;
};

export type CreateDomainResult = {
  providerDomainId: string;
  records: DnsRecord[];
};

export type DomainStatusResult = {
  status: EmailDomainStatus;
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  records: DnsRecord[];
};

/** Future: Journey SEND_EMAIL node payload shape. */
export type JourneySendEmailPayload = {
  templateId?: string;
  subject: string;
  html?: string;
  text?: string;
  variables?: Record<string, string>;
};

/** Future: AI action send_email payload shape. */
export type AiSendEmailActionPayload = {
  to: string;
  subject: string;
  body: string;
};

/** Future: email campaign batch item. */
export type EmailCampaignRecipient = {
  email: string;
  variables?: Record<string, string>;
};
