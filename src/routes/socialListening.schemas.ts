import { z } from 'zod';

export const socialListeningSettingsBodySchema = z.record(z.unknown()).default({});

export const socialListeningRangeQuerySchema = z.object({
  range: z.string().optional(),
  platform: z.string().optional(),
});

export const socialListeningLimitQuerySchema = z.object({
  limit: z.string().optional(),
  platform: z.string().optional(),
});

export const socialListeningTopPostsQuerySchema = z.object({
  range: z.string().optional(),
  limit: z.string().optional(),
  platform: z.string().optional(),
});

export const socialListeningAutomationQuerySchema = z.object({
  postIds: z.string().optional(),
});

export const socialListeningPostParamsSchema = z.object({
  postId: z.string(),
});

export const socialListeningCommentsQuerySchema = z.object({
  status: z.string().optional(),
  postId: z.string().optional(),
  platform: z.string().optional(),
});

export const socialListeningCommentParamsSchema = z.object({
  id: z.string(),
});

export const socialListeningActionBodySchema = z
  .object({
    action: z.string().optional(),
    message: z.string().optional(),
    instagramUserId: z.string().optional(),
    hidden: z.boolean().optional(),
  })
  .default({});

export const socialListeningRetryDmBodySchema = z
  .object({
    instagramUserId: z.string().optional(),
  })
  .default({});
