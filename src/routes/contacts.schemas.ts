import { z } from 'zod';

export const contactCreateSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.string()).optional(),
  ownerId: z.string().optional(),
});

export const contactImportRowSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5),
  email: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const contactImportSchema = z.object({
  contacts: z.array(contactImportRowSchema).min(1).max(5000),
});

export const contactTagBodySchema = z.object({
  tag: z.string(),
});

export const contactLinkBodySchema = z.object({
  otherContactId: z.string().min(1),
});

export const contactAutomationPauseSchema = z.object({
  paused: z.boolean(),
});

export const contactUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(5).optional(),
  email: z.union([z.string().email(), z.null(), z.literal('')]).optional(),
  tags: z.array(z.string()).optional(),
  excludeFromInsights: z.boolean().optional(),
  customFields: z.record(z.string()).optional(),
});
