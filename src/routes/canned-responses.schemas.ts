import { z } from 'zod';

export const cannedCreateSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().max(4000),
  shortcut: z.string().max(32).nullable().optional(),
});

export const cannedUpdateSchema = cannedCreateSchema.partial();
