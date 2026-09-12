import { z } from 'zod';

export const igBusinessConnectBodySchema = z.object({
  code: z.string().optional(),
  redirectUri: z.string().optional(),
});

export const igBusinessCommentParamsSchema = z.object({
  commentId: z.string(),
});

export const igBusinessReplyBodySchema = z.object({
  message: z.string().optional(),
  instagramUserId: z.string().optional(),
});

export const igBusinessHideBodySchema = z.object({
  hidden: z.boolean().optional(),
  instagramUserId: z.string().optional(),
});

export const igBusinessDeleteBodySchema = z
  .object({
    instagramUserId: z.string().optional(),
  })
  .default({});
