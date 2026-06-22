import { z } from 'zod';
import { DEVELOPER_ACTION_TYPES } from '../types/developers.types.js';

const eventListSchema = z.array(z.string().min(1).max(64)).default([]);

export const updateIncomingWebhookSchema = z.object({
  enabled: z.boolean().optional(),
  subscribedEvents: eventListSchema.optional(),
  regenerateSecret: z.boolean().optional(),
});

export const createOutgoingWebhookSchema = z.object({
  name: z.string().min(1).max(128),
  url: z.string().url().max(2048),
  secret: z.string().max(256).optional(),
  enabled: z.boolean().default(true),
  subscribedEvents: eventListSchema,
  maxRetries: z.number().int().min(0).max(10).default(3),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000),
});

export const updateOutgoingWebhookSchema = createOutgoingWebhookSchema.partial();

export const upsertActionSchema = z.object({
  actionType: z.enum(DEVELOPER_ACTION_TYPES),
  name: z.string().min(1).max(128),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  url: z.string().max(2048).default(''),
  headers: z.record(z.string()).default({}),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  enabled: z.boolean().default(false),
});

export const webhookLogsQuerySchema = z.object({
  direction: z.enum(['incoming', 'outgoing']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type UpdateIncomingWebhookDto = z.infer<typeof updateIncomingWebhookSchema>;
export type CreateOutgoingWebhookDto = z.infer<typeof createOutgoingWebhookSchema>;
export type UpdateOutgoingWebhookDto = z.infer<typeof updateOutgoingWebhookSchema>;
export type UpsertActionDto = z.infer<typeof upsertActionSchema>;
export type WebhookLogsQueryDto = z.infer<typeof webhookLogsQuerySchema>;
