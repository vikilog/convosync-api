import { z } from 'zod';

export const guestTokenSchema = z.object({ token: z.string().min(10) });

export const createCallBodySchema = z.object({
  conversationId: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']).optional(),
});

export const listCallsQuerySchema = z.object({
  conversationId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const callAnalyticsBodySchema = z.record(z.unknown());

export const transcribeBodySchema = z.object({
  language: z.string().min(2).max(16).optional(),
});
