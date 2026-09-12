import { z } from 'zod';

export const messengerConnectBodySchema = z
  .object({
    pageId: z.string().optional(),
  })
  .default({});

export const messengerDisconnectQuerySchema = z.object({
  pageId: z.string().optional(),
});

export const messengerDisconnectBodySchema = z
  .object({
    pageId: z.string().optional(),
  })
  .default({});

export const messengerSyncBodySchema = z
  .object({
    maxPages: z.number().optional(),
  })
  .default({});
