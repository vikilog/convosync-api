import { z } from 'zod';

export const leadIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const leadListQuerySchema = z.object({
  source: z.string().min(1).optional(),
  funnelId: z.string().min(1).optional(),
});

export const leadCreateSchema = z.object({
  funnelId: z.string().min(1),
  socialCommentId: z.string().min(1).optional(),
  name: z.string().optional(),
  requirement: z.string().optional(),
  source: z.string().optional(),
});

export const leadUpdateSchema = z.object({
  stage: z.string().optional(),
  stageId: z.string().optional(),
  name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  requirement: z.string().optional(),
  notes: z.string().optional(),
});

export type LeadIdParams = z.infer<typeof leadIdParamsSchema>;
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;
export type LeadCreateBody = z.infer<typeof leadCreateSchema>;
export type LeadUpdateBody = z.infer<typeof leadUpdateSchema>;
