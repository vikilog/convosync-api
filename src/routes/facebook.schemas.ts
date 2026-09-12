import { z } from 'zod';

export const facebookOauthCodeBodySchema = z.object({
  code: z.string().optional(),
  redirectUri: z.string().optional(),
});

export const facebookConnectBodySchema = z.object({
  code: z.string().optional(),
  redirectUri: z.string().optional(),
  pageId: z.string().optional(),
  pageAccessToken: z.string().optional(),
  pageName: z.string().optional(),
  connectToken: z.string().optional(),
});

export const facebookPostParamsSchema = z.object({
  postId: z.string(),
});

export const facebookCreatePostBodySchema = z.object({
  message: z.string().optional(),
  scheduledTime: z.string().optional(),
});
