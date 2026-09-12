import { z } from 'zod';

export const audienceFilterSchema = z.object({
  channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
  segmentId: z.string().optional(),
  segmentIds: z.array(z.string()).optional(),
  tag: z.string().optional(),
  tagMatchMode: z.enum(['any', 'all']).optional(),
  variableMappings: z.record(z.string()).optional(),
  headerMediaStorageKey: z.string().optional(),
  headerMediaMimeType: z.string().optional(),
  headerMediaFileName: z.string().optional(),
  headerMediaAssetId: z.string().optional(),
  replyHandling: z.enum(['default', 'journey', 'ai_agent']).optional(),
  replyJourneyId: z.string().optional(),
  replyAgentId: z.string().optional(),
});

export const campaignCreateSchema = z.object({
  name: z.string().trim().min(1),
  templateId: z.string().min(1),
  channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
  audienceType: z.enum(['all', 'segment', 'tag', 'csv']),
  audienceFilter: audienceFilterSchema.optional(),
  scheduledAt: z.string().optional(),
});

export const campaignUpdateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    templateId: z.string().min(1).optional(),
    channel: z.enum(['whatsapp', 'email', 'instagram']).optional(),
    audienceType: z.enum(['all', 'segment', 'tag', 'csv']).optional(),
    audienceFilter: audienceFilterSchema.optional(),
    scheduledAt: z.string().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.templateId !== undefined ||
      b.audienceType !== undefined ||
      b.audienceFilter !== undefined ||
      b.scheduledAt !== undefined,
    { message: 'Nothing to update' }
  );

export type CampaignCreateBody = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateBody = z.infer<typeof campaignUpdateSchema>;
