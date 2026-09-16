import { z } from 'zod';

export const templateGroupBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export const templateGroupUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  order: z.number().int().optional(),
});

export type TemplateGroupBody = z.infer<typeof templateGroupBodySchema>;
export type TemplateGroupUpdateBody = z.infer<typeof templateGroupUpdateSchema>;
