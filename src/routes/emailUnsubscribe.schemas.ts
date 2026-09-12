import { z } from 'zod';

export const emailUnsubscribeQuerySchema = z.object({
  t: z.string().optional(),
});
