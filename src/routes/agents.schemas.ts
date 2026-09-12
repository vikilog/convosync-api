import { z } from 'zod';

export const AGENT_CATEGORY = z.enum(['ai_agent', 'responsive', 'rule_based']);
export const INTENT_FALLBACK = z.enum(['silent', 'automated_response', 'transfer_human']);

export const agentCreateSchema = z.object({
  name: z.string().min(1),
  category: AGENT_CATEGORY.default('ai_agent'),
  role: z
    .enum(['lead_acquisition', 'customer_service', 'shop_assistant', 'custom'])
    .optional(),
  systemPrompt: z.string().optional(),
  captureFields: z.array(z.string()).optional(),
  escalationRules: z.record(z.unknown()).optional(),
});

export const profileUpdateSchema = z.object({
  name: z.string().min(1).max(250).optional(),
  description: z.string().max(500).nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  welcomeMessageEnabled: z.boolean().optional(),
  welcomeMessageText: z.string().max(1000).nullable().optional(),
  intentFallback: INTENT_FALLBACK.optional(),
  conversationCloseWaitMins: z.number().int().min(1).max(10).optional(),
  systemPrompt: z.string().optional(),
  instructions: z.string().max(5000).nullable().optional(),
  toneOfVoice: z.enum(['professional', 'humorous', 'casual', 'friendly']).optional(),
  fallbackLanguage: z
    .enum(['english', 'hindi', 'hinglish', 'spanish', 'arabic', 'french'])
    .optional(),
  brandBackground: z.string().max(1200).nullable().optional(),
  actions: z
    .array(
      z.object({
        type: z.enum([
          'close_conversations',
          'escalate_to_human',
          'add_contact_tags',
          'update_contact_attributes',
        ]),
        enabled: z.boolean(),
        instruction: z.string().max(1000),
      })
    )
    .optional(),
  isPublished: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  voiceAgentEnabled: z.boolean().optional(),
  voiceSttProvider: z.string().min(1).optional(),
  voiceTtsProvider: z.string().min(1).optional(),
  voiceTtsVoiceId: z.string().min(1).nullable().optional(),
  /** Knowledge match / escalate low bar (0–1). null clears override → env default. */
  similarityLowThreshold: z.number().min(0).max(1).nullable().optional(),
  flowDefinition: z.record(z.unknown()).optional(),
});

export const skillCreateSchema = z.object({
  title: z.string().min(1).max(200),
  trigger: z.string().default(''),
  instructions: z.string().default(''),
  description: z.string().max(500).nullable().optional(),
  knowledgeItemIds: z.array(z.string().min(1)).optional(),
  status: z.enum(['draft', 'live']).optional(),
});

export const skillUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  trigger: z.string().optional(),
  instructions: z.string().optional(),
  description: z.string().max(500).nullable().optional(),
  knowledgeItemIds: z.array(z.string().min(1)).optional(),
  status: z.enum(['draft', 'live']).optional(),
});

export const knowledgeCreateSchema = z.object({
  type: z.enum(['document', 'online_data', 'qna', 'attachment']),
  title: z.string().min(1).max(200),
  content: z.string().optional(),
  url: z.string().url().optional().or(z.literal('')),
  fileUrl: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const knowledgeUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().nullable().optional(),
  url: z.string().url().optional().or(z.literal('')).nullable(),
  fileUrl: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(['ready', 'processing', 'failed']).optional(),
});

export const agentChatSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
  channel: z.string().optional(),
});

export const agentTestSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationHistory: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .default([]),
});

export const knowledgeFetchUrlSchema = z.object({
  url: z.string().min(1),
  refreshInterval: z.enum(['daily', 'weekly', 'manual']).default('weekly'),
});

/** Voice preview TTS body. text stays optional — handler still requires a non-empty trim. */
export const voicePreviewTtsSchema = z.object({
  text: z.string().optional(),
});

export type AgentCreateBody = z.infer<typeof agentCreateSchema>;
export type ProfileUpdateBody = z.infer<typeof profileUpdateSchema>;
export type SkillCreateBody = z.infer<typeof skillCreateSchema>;
export type SkillUpdateBody = z.infer<typeof skillUpdateSchema>;
export type KnowledgeCreateBody = z.infer<typeof knowledgeCreateSchema>;
export type KnowledgeUpdateBody = z.infer<typeof knowledgeUpdateSchema>;
export type AgentChatBody = z.infer<typeof agentChatSchema>;
export type AgentTestBody = z.infer<typeof agentTestSchema>;
export type KnowledgeFetchUrlBody = z.infer<typeof knowledgeFetchUrlSchema>;
export type VoicePreviewTtsBody = z.infer<typeof voicePreviewTtsSchema>;
