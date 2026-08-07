import { z } from 'zod';
import { EMAIL_PROVIDER_CONFIG_TYPES } from '../types/provider-config.types.js';

export const createDomainSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, {
      message: 'Invalid domain format',
    }),
  provider: z.enum(['resend', 'ses', 'sendgrid', 'smtp']).optional().default('resend'),
});

export const verifyDomainSchema = z.object({
  domainId: z.string().min(1),
});

export const createSenderSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email({ message: 'Enter a valid sender email (e.g. support@yourdomain.com)' }),
  displayName: z.string().max(120).optional(),
  isDefault: z.boolean().optional().default(false),
  domainId: z.string().optional(),
  useSharedDomain: z.boolean().optional().default(false),
});

export const setDefaultSenderSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const sendEmailSchema = z.object({
  from: z.string().email().optional(),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
  subject: z.string().min(1).max(998).optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  replyTo: z.string().email().optional(),
  template: z.string().optional(),
  templateId: z.string().optional(),
  variables: z.record(z.string()).optional(),
  campaignId: z.string().optional(),
  contactId: z.string().optional(),
}).refine(
  (data) => data.templateId || data.subject,
  { message: 'Provide subject or templateId', path: ['subject'] }
);

export const upsertEmailTemplateSchema = z.object({
  // Internal label only (not Meta) — spaces/hyphens OK
  name: z.string().trim().min(1).max(120),
  subject: z.string().min(1).max(998),
  htmlBody: z.string().min(1),
  textBody: z.string().optional(),
  status: z.enum(['draft', 'active']).optional().default('draft'),
  designJson: z.record(z.unknown()).optional().nullable(),
});

export const updateEmailTemplateSchema = upsertEmailTemplateSchema.partial();

export const aiGenerateEmailTemplateSchema = z.object({
  prompt: z.string().min(3).max(2000),
});

export const listLogsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const createProviderSchema = z.object({
  provider: z.enum(EMAIL_PROVIDER_CONFIG_TYPES),
  isDefault: z.boolean().optional().default(false),
  config: z.record(z.unknown()).optional(),
});

export const updateProviderSchema = z.object({
  isDefault: z.boolean().optional(),
  status: z.enum(['active', 'disabled', 'credentials_missing', 'connection_failed']).optional(),
  config: z.record(z.unknown()).optional(),
});

/** Draft SES credentials for identity refresh / test-send (Add form or Edit overrides). */
export const sesCredentialsDraftSchema = z.object({
  accessKeyId: z.string().min(1).max(200).optional(),
  secretAccessKey: z.string().min(1).max(500).optional(),
  region: z.string().min(1).max(64).optional(),
  senderEmail: z.string().email().max(320).optional(),
});

export type CreateDomainDto = z.infer<typeof createDomainSchema>;
export type VerifyDomainDto = z.infer<typeof verifyDomainSchema>;
export type CreateSenderDto = z.infer<typeof createSenderSchema>;
export type SendEmailDto = z.infer<typeof sendEmailSchema>;
export type CreateProviderDto = z.infer<typeof createProviderSchema>;
export type UpdateProviderDto = z.infer<typeof updateProviderSchema>;
export type SesCredentialsDraftDto = z.infer<typeof sesCredentialsDraftSchema>;
export type UpsertEmailTemplateDto = z.infer<typeof upsertEmailTemplateSchema>;
export type UpdateEmailTemplateDto = z.infer<typeof updateEmailTemplateSchema>;
