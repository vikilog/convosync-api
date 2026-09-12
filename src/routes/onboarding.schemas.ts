import { z } from 'zod';

export const onboardingStepBodySchema = z.object({
  step: z.number().int().min(1).max(7),
  skip: z.boolean().optional(),
  data: z.record(z.unknown()).optional(),
});
