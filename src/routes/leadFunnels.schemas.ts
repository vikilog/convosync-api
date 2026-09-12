import { z } from 'zod';

export const funnelIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const funnelStageParamsSchema = z.object({
  id: z.string().min(1),
  stageId: z.string().min(1),
});

export const funnelWriteSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  goal: z.string().optional(),
});

export const funnelPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  goal: z.string().optional(),
});

export const funnelStageWriteSchema = z.object({
  name: z.string().trim().min(1),
  isFinal: z.boolean().optional(),
});

export const funnelStagePatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  isFinal: z.boolean().optional(),
});

export type FunnelIdParams = z.infer<typeof funnelIdParamsSchema>;
export type FunnelStageParams = z.infer<typeof funnelStageParamsSchema>;
export type FunnelWriteBody = z.infer<typeof funnelWriteSchema>;
export type FunnelPatchBody = z.infer<typeof funnelPatchSchema>;
export type FunnelStageWriteBody = z.infer<typeof funnelStageWriteSchema>;
export type FunnelStagePatchBody = z.infer<typeof funnelStagePatchSchema>;
