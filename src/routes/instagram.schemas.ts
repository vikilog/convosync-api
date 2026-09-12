import { z } from 'zod';

export const instagramPreviewBodySchema = z.object({
  code: z.string().optional(),
  redirectUri: z.string().optional(),
});

export const instagramConnectBodySchema = z.object({
  code: z.string().optional(),
  redirectUri: z.string().optional(),
  pageId: z.string().optional(),
  connectToken: z.string().optional(),
});

export const instagramUserQuerySchema = z.object({
  instagramUserId: z.string().optional(),
});

export const instagramListeningListQuerySchema = z.object({
  instagramUserId: z.string().optional(),
  after: z.string().optional(),
  limit: z.string().optional(),
});

export const instagramMediaParamsSchema = z.object({
  mediaId: z.string(),
});

export const instagramCommentParamsSchema = z.object({
  commentId: z.string(),
});

export const instagramReplyBodySchema = z
  .object({
    message: z.string().optional(),
    instagramUserId: z.string().optional(),
  })
  .default({});

export const instagramDisconnectQuerySchema = z.object({
  instagramUserId: z.string().optional(),
});

export const instagramDisconnectBodySchema = z
  .object({
    instagramUserId: z.string().optional(),
  })
  .default({});

export const instagramSyncBodySchema = z
  .object({
    maxPages: z.number().optional(),
    loadMore: z.boolean().optional(),
  })
  .default({});
