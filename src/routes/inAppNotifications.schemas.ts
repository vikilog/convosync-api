import { z } from 'zod';

export const inAppNotificationListQuerySchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const inAppNotificationActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
