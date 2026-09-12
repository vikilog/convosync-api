import { z } from 'zod';

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_HISTORY_TURNS = 20;

export const widgetConfigQuerySchema = z.object({
  token: z.string().min(1),
});

export const chatSchema = z.object({
  token: z.string().min(1),
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(MAX_MESSAGE_LENGTH),
      })
    )
    .max(MAX_HISTORY_TURNS)
    .optional(),
});
