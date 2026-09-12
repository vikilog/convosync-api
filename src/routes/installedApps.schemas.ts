import { z } from 'zod';

export const installedAppParamsSchema = z.object({
  appId: z.string(),
});
