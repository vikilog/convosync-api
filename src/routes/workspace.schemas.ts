import { z } from 'zod';
import { CUSTOM_PLAN_PRICING_RULES } from '../services/customPlanPricing.js';
import { isValidIanaTimeZone } from '../services/geoip/index.js';
import { isWorkspacePermission } from '../services/workspacePermissions.js';

export const customPlanQuoteSchema = z.object({
  contacts: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.contacts.min).max(CUSTOM_PLAN_PRICING_RULES.limits.contacts.max),
  aiAgents: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.aiAgents.min).max(CUSTOM_PLAN_PRICING_RULES.limits.aiAgents.max),
  teamMembers: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.teamMembers.min).max(CUSTOM_PLAN_PRICING_RULES.limits.teamMembers.max),
  channels: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.channels.min).max(CUSTOM_PLAN_PRICING_RULES.limits.channels.max),
  emails: z.coerce.number().int().min(CUSTOM_PLAN_PRICING_RULES.limits.emails.min).max(CUSTOM_PLAN_PRICING_RULES.limits.emails.max),
});

const memberRoleSchema = z.enum(['admin', 'agent']);

const permissionsSchema = z
  .array(z.string())
  .optional()
  .transform((values) => (values ?? []).filter((value) => isWorkspacePermission(value)));

const inboxScopeSchema = z
  .object({
    mode: z.enum(['all', 'restricted']),
    channels: z.array(z.enum(['whatsapp', 'instagram', 'messenger'])).optional(),
    accounts: z
      .object({
        whatsapp: z.array(z.string().min(1)).optional(),
        instagram: z.array(z.string().min(1)).optional(),
        messenger: z.array(z.string().min(1)).optional(),
      })
      .optional(),
  })
  .optional();

export const addMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).optional(),
  password: z.string().min(8).optional(),
  role: memberRoleSchema.default('agent'),
  permissions: permissionsSchema,
  inboxScope: inboxScopeSchema,
});

export const updateMemberSchema = z.object({
  role: memberRoleSchema,
  permissions: permissionsSchema,
  inboxScope: inboxScopeSchema,
  autoAssignEligible: z.boolean().optional(),
  assignmentLimit: z.number().int().min(0).max(1000).nullable().optional(),
});

const inboxRuleBusinessHoursSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1).optional(),
});

const inboxRuleConditionsSchema = z.object({
  channels: z.array(z.enum(['whatsapp', 'instagram', 'messenger'])).optional(),
  contactTags: z.array(z.string().min(1)).optional(),
  businessHours: inboxRuleBusinessHoursSchema.optional(),
});

export const inboxRuleCreateSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  conditions: inboxRuleConditionsSchema,
  actionType: z.enum(['group', 'user']),
  actionGroupId: z.string().min(1).optional().nullable(),
  actionUserId: z.string().min(1).optional().nullable(),
});

export const inboxRuleUpdateSchema = inboxRuleCreateSchema.partial();

export const inboxBehaviorUpdateSchema = z.object({
  mode: z.enum(['off', 'basic', 'advanced']).optional(),
  timezone: z.string().nullable().optional(),
});

export const companyUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  legalName: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  website: z.string().max(500).optional().nullable(),
  email: z.union([z.string().email(), z.literal(''), z.null()]).optional(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  timezone: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  logoUrl: z.union([z.string(), z.null()]).optional(),
});

export const localeUpdateSchema = z.object({
  country: z.string().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()),
  timezone: z.string().min(1).refine(isValidIanaTimeZone, 'Invalid IANA timezone'),
});

export const localeDetectQuerySchema = z.object({
  browserTimezone: z.string().optional(),
});

export const verificationSendBodySchema = z.object({
  target: z.string(),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(32).optional(),
});

export const verificationVerifyBodySchema = z.object({
  target: z.string(),
  code: z.string().trim().min(4).max(12),
});

export const inboxGroupNameSchema = z.object({
  name: z.string().min(1).max(120),
});

export const inboxGroupMemberBodySchema = z.object({
  membershipId: z.string().min(1),
});

export const inboxRuleReorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)),
});

export const automationUpdateSchema = z.object({
  automationsPaused: z.boolean().optional(),
  defaultReplyEnabled: z.boolean().optional(),
  defaultReplyText: z.string().max(2000).optional().nullable(),
  persistentMenu: z
    .object({
      enabled: z.boolean(),
      items: z
        .array(
          z.object({
            id: z.string().min(1).max(64),
            title: z.string().min(1).max(30),
            type: z.enum(['postback', 'web_url']),
            payload: z.string().max(1000).optional(),
            url: z.string().url().max(500).optional(),
          })
        )
        .max(5),
    })
    .optional(),
  syncMenu: z.boolean().optional(),
});

export const tagCreateSchema = z.object({
  name: z.string().min(1).max(64),
  folder: z.string().max(64).nullable().optional(),
});

export const tagUpdateSchema = tagCreateSchema.partial();

const notificationChannelsSchema = z.object({
  email: z
    .object({
      enabled: z.boolean(),
      recipients: z.object({
        workspaceEmail: z.boolean(),
        userIds: z.array(z.string().min(1)).max(50),
        extraEmails: z.array(z.string().email()).max(20),
      }),
      subjectTemplate: z.string().min(1).max(200).optional(),
      bodyTemplate: z.string().min(1).max(5000).optional(),
    })
    .optional(),
  whatsapp: z
    .object({
      enabled: z.boolean(),
      phoneNumbers: z.array(z.string().min(8).max(20)).max(20),
      userIds: z.array(z.string().min(1)).max(50),
      templateId: z.string().min(1).nullable(),
      variableMap: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  inApp: z.object({ enabled: z.boolean() }).optional(),
});

export const notificationUpsertSchema = z.object({
  eventType: z.string().min(1),
  enabled: z.boolean().optional(),
  channels: notificationChannelsSchema.optional(),
});

export function normalizeOptionalUrls<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = { ...data };
  for (const key of ['website', 'email', 'logoUrl'] as const) {
    if (key in out && out[key] === '') out[key] = null;
  }
  return out as T;
}
