import { z } from 'zod';

const connectionStringField = z
  .string()
  .min(10, 'Connection string is required')
  .refine(
    (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
    'Must be a valid MongoDB connection string'
  );

const venueIdField = z.string().min(1, 'Venue ID is required').max(128);

export const syncAiKnowledgeSchema = z.object({
  connectionString: connectionStringField,
  venueId: venueIdField,
});

export const saveAiKnowledgeConfigSchema = z.object({
  connectionString: connectionStringField.optional(),
  venueId: z.string().min(1).max(128),
});

export const listCollectionsSchema = z.object({
  connectionString: connectionStringField,
  venueId: venueIdField,
});

export const syncCollectionSchema = z.object({
  connectionString: connectionStringField,
  venueId: venueIdField,
  collectionName: z.string().min(1, 'Collection name is required').max(128),
});

export const aiContextQuerySchema = z.object({
  query: z.string().min(1, 'Query is required').max(4000),
  venueId: venueIdField,
});

export type SyncAiKnowledgeDto = z.infer<typeof syncAiKnowledgeSchema>;
export type SaveAiKnowledgeConfigDto = z.infer<typeof saveAiKnowledgeConfigSchema>;
export type ListCollectionsDto = z.infer<typeof listCollectionsSchema>;
export type SyncCollectionDto = z.infer<typeof syncCollectionSchema>;
export type AiContextQueryDto = z.infer<typeof aiContextQuerySchema>;
