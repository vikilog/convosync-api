import { z } from 'zod';

export const templateBodySchema = z.object({
  name: z.string().min(1),
  category: z.enum(['Utility', 'Marketing', 'Authentication', 'UTILITY', 'MARKETING', 'AUTHENTICATION']),
  language: z.string().min(2).default('en'),
  bodyPattern: z.string().min(1),
  header: z.string().optional().nullable(),
  headerFormat: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).optional().nullable(),
  headerMediaHandle: z.string().optional().nullable(),
  headerMediaStorageKey: z.string().optional().nullable(),
  headerMediaMimeType: z.string().optional().nullable(),
  headerMediaFileName: z.string().optional().nullable(),
  footer: z.string().optional().nullable(),
  variables: z.array(z.string()).optional(),
  buttonType: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'FLOW']).optional().nullable(),
  buttonText: z.string().optional().nullable(),
  buttonUrl: z.string().optional().nullable(),
  buttonPhoneNumber: z.string().optional().nullable(),
  buttonUrlSample: z.string().optional().nullable(),
  buttonFlowId: z.string().optional().nullable(),
  variableSamples: z.array(z.string()).optional(),
  submitToMeta: z.boolean().optional(),
});

export const templateUpdateSchema = templateBodySchema.partial();

export type TemplateBody = z.infer<typeof templateBodySchema>;
export type TemplateUpdateBody = z.infer<typeof templateUpdateSchema>;
