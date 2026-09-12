import { z } from 'zod';

export const teamChatMessagesQuerySchema = z.object({
  peerUserId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().optional(),
});

export const teamChatMessageCreateSchema = z.object({
  body: z.string().min(1).max(4000),
  recipientUserId: z.string().min(1),
});
