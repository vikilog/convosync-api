import { z } from 'zod';

export const webWidgetUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  botName: z.string().trim().min(1).max(60).optional(),
  greeting: z.string().trim().min(1).max(300).optional(),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #16a34a')
    .optional(),
  agentId: z.string().min(1).nullable().optional(),
});
