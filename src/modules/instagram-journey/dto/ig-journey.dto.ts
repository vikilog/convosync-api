import { z } from 'zod';
import { IG_JOURNEY_NODE_TYPES, IG_JOURNEY_STATUSES } from '../types/ig-journey.types.js';

export const createIgJourneySchema = z.object({
  name: z.string().min(1).max(200),
});

export const updateIgJourneySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(IG_JOURNEY_STATUSES).optional(),
});

export const igGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(IG_JOURNEY_NODE_TYPES),
  data: z.record(z.unknown()).default({}),
  positionX: z.number(),
  positionY: z.number(),
});

export const igGraphEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  conditionValue: z.string().nullable().optional(),
});

export const saveIgGraphSchema = z.object({
  nodes: z.array(igGraphNodeSchema),
  edges: z.array(igGraphEdgeSchema),
});

export type CreateIgJourneyDto = z.infer<typeof createIgJourneySchema>;
export type UpdateIgJourneyDto = z.infer<typeof updateIgJourneySchema>;
export type SaveIgGraphDto = z.infer<typeof saveIgGraphSchema>;
