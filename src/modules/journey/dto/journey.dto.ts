import { z } from 'zod';
import { CONDITION_OPERATORS, JOURNEY_NODE_TYPES, JOURNEY_STATUSES } from '../types/journey.types.js';

export const createJourneySchema = z.object({
  name: z.string().min(1).max(200),
});

export const updateJourneySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(JOURNEY_STATUSES).optional(),
});

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(JOURNEY_NODE_TYPES),
  data: z.record(z.unknown()).default({}),
  positionX: z.number(),
  positionY: z.number(),
});

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  conditionValue: z.string().nullable().optional(),
});

export const saveGraphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

export const triggerJourneySchema = z.object({
  event: z.string().min(1),
  contactId: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});

export const conditionNodeDataSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.union([z.string(), z.number()]),
});

export type CreateJourneyDto = z.infer<typeof createJourneySchema>;
export type UpdateJourneyDto = z.infer<typeof updateJourneySchema>;
export type SaveGraphDto = z.infer<typeof saveGraphSchema>;
export type TriggerJourneyDto = z.infer<typeof triggerJourneySchema>;
