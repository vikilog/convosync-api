import { z } from 'zod';

export const updateAiProviderSchema = z.object({
  mode: z.enum(['convosync', 'byok']).optional(),
  provider: z.enum(['openai', 'anthropic', 'custom']).optional(),
  model: z.string().min(1).max(120).optional(),
  apiKey: z.string().min(8).max(500).optional(),
  baseUrl: z.union([z.string().url().max(500), z.literal(''), z.null()]).optional(),
});
