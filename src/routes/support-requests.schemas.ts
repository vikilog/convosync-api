import { z } from 'zod';

export const supportRequestCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  phone: z
    .string()
    .trim()
    .max(40)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  subject: z
    .string()
    .trim()
    .max(160)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  message: z.string().trim().min(1).max(2000),
  source: z.string().trim().max(40).optional().default('landing'),
});
