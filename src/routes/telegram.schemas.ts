import { z } from 'zod';

export const telegramConnectBodySchema = z
  .object({
    botToken: z.string().optional(),
  })
  .default({});

export const telegramDisconnectQuerySchema = z.object({
  botId: z.string().optional(),
});

export const telegramDisconnectBodySchema = z
  .object({
    botId: z.string().optional(),
  })
  .default({});
