import { z } from 'zod';

export const metaDataDeletionStatusQuerySchema = z.object({
  code: z.string().optional(),
});
