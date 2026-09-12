import { z } from 'zod';

export const analyticsMessagesQuerySchema = z.object({
  days: z.string().optional(),
});
