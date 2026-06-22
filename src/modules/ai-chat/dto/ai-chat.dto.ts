import { z } from 'zod';

const aiChatHistoryItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

export const aiChatMessageSchema = z.object({
  venueId: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  customerId: z.string().min(1).max(128),
  channel: z.string().min(1).max(64),
  history: z.array(aiChatHistoryItemSchema).max(20).optional(),
});

export type AiChatMessageDto = z.infer<typeof aiChatMessageSchema>;
