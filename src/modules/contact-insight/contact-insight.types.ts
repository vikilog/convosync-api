import { z } from 'zod';

/** Zod shape for OpenAI Structured Outputs + server-side safety net. */
export const contactInsightLlmSchema = z
  .object({
    isGenuineCustomerInteraction: z.boolean(),
    healthScore: z.number().int().min(0).max(100).nullable(),
    churnRiskScore: z.number().int().min(0).max(100).nullable(),
    purchaseIntentScore: z.number().int().min(0).max(100).nullable(),
    sentimentScore: z.number().int().min(-100).max(100).nullable(),
    summary: z.string().min(1).max(1200),
    painPoints: z.array(z.string().min(1)).max(12),
    interests: z.array(z.string().min(1)).max(12),
    recommendedAction: z.string().min(1).max(500).nullable(),
  })
  .superRefine((v, ctx) => {
    if (!v.isGenuineCustomerInteraction) return;
    for (const key of [
      'healthScore',
      'churnRiskScore',
      'purchaseIntentScore',
      'sentimentScore',
    ] as const) {
      if (v[key] == null) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} required when interaction is genuine`,
        });
      }
    }
    if (!v.recommendedAction?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedAction'],
        message: 'recommendedAction required when interaction is genuine',
      });
    }
  });

export type ContactInsightLlmResult = z.infer<typeof contactInsightLlmSchema>;

export type ContactInsightJobData = {
  workspaceId: string;
  contactId: string;
  reason: 'conversation_resolved' | 'call_transcript_ready' | 'nightly' | 'manual';
  /** Bypass min-gap (manual “Prepare insight” from inbox) */
  force?: boolean;
};

export type InsightContextEvent = {
  at: Date;
  kind: 'chat' | 'call';
  id: string;
  conversationId?: string;
  callSessionId?: string;
  direction: 'inbound' | 'outbound' | 'unknown';
  /** Human-readable bracket label, e.g. "[Chat - inbound - 2026-07-10 14:32]" */
  label: string;
  text: string;
};

export type InsightContextBundle = {
  contactId: string;
  workspaceId: string;
  contactName: string;
  /** Contact.tags at analysis time */
  tags: string[];
  events: InsightContextEvent[];
  conversationIds: string[];
  callSessionIds: string[];
  interactionCount: number;
  /** Earliest event in the interleaved history (null if empty) */
  earliestAt: Date | null;
  /** Latest event in the interleaved history (null if empty) */
  latestAt: Date | null;
  /** Wall clock when this bundle was built (for recency weighing) */
  analyzedAt: Date;
  /**
   * Chronological interleaved chat + call lines only (no contact header).
   * Each line: `[Chat - inbound - 2026-07-10 14:32] …` or `[Call transcript - …] …`
   */
  contextText: string;
};
