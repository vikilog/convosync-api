import { prisma } from '../index.js';
import { AiProviderConfigService } from '../modules/ai-agent/services/ai-provider-config.service.js';
import { LlmClient } from '../modules/ai-agent/services/llm-client.service.js';
import { applySocialListeningAutomation } from './socialListeningSettings.service.js';

/** Matches frontend LOW_CONFIDENCE_THRESHOLD — review queue + badge routing. */
export const SOCIAL_COMMENT_LOW_CONFIDENCE = 0.55;

export const SOCIAL_INTENTS = [
  'interested',
  'question',
  'complaint',
  'spam',
  'unclear',
] as const;

export type SocialIntent = (typeof SOCIAL_INTENTS)[number];

export type SocialCommentStatus =
  | 'new'
  | 'approved'
  | 'replied'
  | 'escalated'
  | 'ignored';

const SYSTEM_PROMPT = `You classify Instagram post comments for a business Social Listening inbox.
Classify intent as exactly ONE of: interested, question, complaint, spam, unclear.

Rules:
- interested: wants to buy, price, demo, "I am interested", "DM me", lead / sales signal
- question: asks how something works, info request without clear purchase intent
- complaint: angry, refund, broken, bad experience, negative feedback
- spam: promo, bot, irrelevant link spam, gibberish
- unclear: too vague to act on, emoji-only, ambiguous

Also suggest a short public reply the brand could post (1-2 sentences, friendly, no hashtags).

Respond with ONLY JSON:
{"intent":"interested","confidence":0.82,"suggestedReply":"..."}
confidence is 0–1.`;

function normalizeConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  // Accept 0–100 or 0–1
  const scaled = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
}

function normalizeIntent(raw: unknown): SocialIntent {
  const s = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/interested_in_business/g, 'interested')
    .replace(/sales/g, 'interested')
    .replace(/neutral/g, 'unclear');
  if ((SOCIAL_INTENTS as readonly string[]).includes(s)) return s as SocialIntent;
  return 'unclear';
}

export function mapIntentToReviewLabel(
  intent: SocialIntent | string | null | undefined
): 'Interested' | 'Question' | 'Complaint' | 'Spam' | 'Neutral' {
  switch (intent) {
    case 'interested':
      return 'Interested';
    case 'question':
      return 'Question';
    case 'complaint':
      return 'Complaint';
    case 'spam':
      return 'Spam';
    default:
      return 'Neutral';
  }
}

export function mapStatusToReviewStatus(
  status: string
): 'pending' | 'approved' | 'ignored' {
  if (status === 'ignored') return 'ignored';
  if (status === 'approved' || status === 'replied' || status === 'escalated') {
    return 'approved';
  }
  return 'pending';
}

/** Needs human review queue (new + low confidence / unclear / spam). */
export function needsReviewQueue(row: {
  status: string;
  intent: string | null;
  confidence: number | null;
}): boolean {
  if (row.status !== 'new') return false;
  if (row.intent == null || row.confidence == null) return true;
  if (row.intent === 'spam' || row.intent === 'unclear') return true;
  return row.confidence < SOCIAL_COMMENT_LOW_CONFIDENCE;
}

export async function classifySocialCommentText(
  workspaceId: string,
  commentText: string
): Promise<{ intent: SocialIntent; confidence: number; suggestedReply: string | null; tokensUsed: number }> {
  const providerConfig = new AiProviderConfigService(prisma);
  const resolved = await providerConfig.resolveForWorkspace(workspaceId);
  const llm = new LlmClient(resolved);

  const result = await llm.complete(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: commentText.slice(0, 2000) },
    ],
    { maxTokens: 120, temperature: 0, jsonMode: true, workspaceId }
  );

  try {
    const parsed = JSON.parse(result.content) as {
      intent?: string;
      confidence?: number;
      suggestedReply?: string;
    };
    return {
      intent: normalizeIntent(parsed.intent),
      confidence: normalizeConfidence(parsed.confidence),
      suggestedReply:
        typeof parsed.suggestedReply === 'string' && parsed.suggestedReply.trim()
          ? parsed.suggestedReply.trim().slice(0, 500)
          : null,
      tokensUsed: result.usage.totalTokens,
    };
  } catch {
    return {
      intent: 'unclear',
      confidence: 0.4,
      suggestedReply: null,
      tokensUsed: result.usage.totalTokens,
    };
  }
}

export async function classifySocialCommentById(
  workspaceId: string,
  socialCommentId: string
): Promise<{
  id: string;
  intent: string | null;
  confidence: number | null;
  classificationStatus: string;
  classificationError: string | null;
  suggestedReply: string | null;
}> {
  const row = await prisma.socialComment.findFirst({
    where: { id: socialCommentId, workspaceId },
  });
  if (!row) throw new Error('Comment not found');

  await prisma.socialComment.update({
    where: { id: row.id },
    data: {
      classificationStatus: 'pending',
      classificationError: null,
    },
  });

  try {
    const result = await classifySocialCommentText(workspaceId, row.commentText);
    const updated = await prisma.socialComment.update({
      where: { id: row.id },
      data: {
        intent: result.intent,
        confidence: result.confidence,
        suggestedReply: result.suggestedReply,
        classificationStatus: 'classified',
        classificationError: null,
      },
    });

    // Auto-response / ignore / escalate based on workspace settings (no-op when master off).
    try {
      await applySocialListeningAutomation({
        workspaceId,
        socialCommentId: updated.id,
        intent: updated.intent,
        confidence: updated.confidence,
      });
    } catch (err) {
      console.warn('[social-comment.classify] automation failed', {
        id: updated.id,
        error: err instanceof Error ? err.message : err,
      });
    }

    return {
      id: updated.id,
      intent: updated.intent,
      confidence: updated.confidence,
      classificationStatus: updated.classificationStatus,
      classificationError: updated.classificationError,
      suggestedReply: updated.suggestedReply,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Classification failed';
    const updated = await prisma.socialComment.update({
      where: { id: row.id },
      data: {
        classificationStatus: 'failed',
        classificationError: message.slice(0, 500),
      },
    });
    return {
      id: updated.id,
      intent: updated.intent,
      confidence: updated.confidence,
      classificationStatus: updated.classificationStatus,
      classificationError: updated.classificationError,
      suggestedReply: updated.suggestedReply,
    };
  }
}

/** Fire-and-forget classify for pending/failed rows (capped). */
export function enqueueClassifyPendingComments(
  workspaceId: string,
  socialCommentIds: string[],
  limit = 20
): void {
  const ids = socialCommentIds.slice(0, limit);
  void (async () => {
    for (const id of ids) {
      try {
        await classifySocialCommentById(workspaceId, id);
      } catch (err) {
        console.warn('[social-comment.classify]', id, err instanceof Error ? err.message : err);
      }
    }
  })();
}
