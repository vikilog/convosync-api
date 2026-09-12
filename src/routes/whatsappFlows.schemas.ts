import { z } from 'zod';

// Light structural check, not full Meta Flow JSON schema validation — MVP guard
// against obviously malformed JSON, not a spec-compliance validator.
export const flowJsonSchema = z
  .object({
    version: z.string().min(1),
    screens: z.array(z.record(z.string(), z.unknown())).min(1),
  })
  .passthrough();

export const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  flowJson: flowJsonSchema,
  categories: z.array(z.string()).optional().default([]),
});

export const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  flowJson: flowJsonSchema.optional(),
  categories: z.array(z.string()).optional(),
});

export const sendTestSchema = z.object({
  phone: z.string().trim().min(6),
  bodyText: z.string().trim().min(1).max(1024).optional(),
  ctaLabel: z.string().trim().min(1).max(30).optional(),
});
