/**
 * Contact-insight LLM: fixed system prompt + per-contact user message,
 * OpenAI Structured Outputs (json_schema strict), Zod safety net.
 */

import { UnrecoverableError } from 'bullmq';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import { AiProviderConfigService } from '../ai-agent/services/ai-provider-config.service.js';
import { LlmClient, LlmClientError } from '../ai-agent/services/llm-client.service.js';
import { formatInsightTimestamp } from './contact-insight.context.js';
import {
  contactInsightLlmSchema,
  type ContactInsightLlmResult,
  type InsightContextBundle,
} from './contact-insight.types.js';

/** Strict JSON Schema for OpenAI Structured Outputs (mirrors Zod). */
export const CONTACT_INSIGHT_OPENAI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isGenuineCustomerInteraction',
    'healthScore',
    'churnRiskScore',
    'purchaseIntentScore',
    'sentimentScore',
    'summary',
    'painPoints',
    'interests',
    'recommendedAction',
  ],
  properties: {
    isGenuineCustomerInteraction: { type: 'boolean' },
    healthScore: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
    churnRiskScore: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
    purchaseIntentScore: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
    sentimentScore: { type: ['integer', 'null'], minimum: -100, maximum: 100 },
    summary: { type: 'string', minLength: 1, maxLength: 1200 },
    painPoints: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1 },
    },
    interests: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1 },
    },
    recommendedAction: { type: ['string', 'null'], minLength: 1, maxLength: 500 },
  },
} as const;

/** Fixed system instructions — byte-stable across contacts for OpenAI prompt caching. */
export const CONTACT_INSIGHT_SYSTEM_PROMPT = `You are a customer success analyst for a messaging + voice support platform (WhatsApp/Instagram/Messenger chats and LiveKit call transcripts).

You will receive one contact's chronologically ordered interaction history. Each line is labeled with source, direction, and timestamp, for example:
- [Chat - inbound - 2026-07-10 14:32] — customer typed message
- [Chat - outbound - 2026-07-10 14:33] — agent/bot reply
- [Call transcript - inbound - 2026-07-12 09:15] or [Call transcript - outbound - …] — full call transcript from speech-to-text

Analyze the FULL history and return ONLY the structured JSON object defined by the response schema.

Genuine vs non-customer filter:
- Set isGenuineCustomerInteraction to true only when the history includes clear external-customer needs (support, purchase, complaint, onboarding, etc.).
- Set isGenuineCustomerInteraction to false when the history is ONLY internal testing, teammates discussing the product/feature, sandbox/demo scripts, staff-to-staff chat, or otherwise unrelated to a real external customer.
- MIXED history (genuine customer signals AND internal/test content): set isGenuineCustomerInteraction to true, but base ALL scores ONLY on the genuine customer portions. Ignore internal/test messages entirely when scoring. Do not let test/internal tone affect sentiment or churn. In summary, briefly note that internal/test turns were excluded from scoring.
- When isGenuineCustomerInteraction is false:
  - healthScore, churnRiskScore, purchaseIntentScore, and sentimentScore must be null (do not invent calibrated scores).
  - recommendedAction must be null.
  - summary: 1–2 sentences explaining why this was classified as non-genuine.
  - painPoints / interests: [] unless clearly evidenced — do not fabricate.
- When isGenuineCustomerInteraction is true: all four scores and recommendedAction must be non-null (scores from genuine portions only if mixed).

Scoring guidance (0–100 unless noted) — apply only to genuine customer portions:
- healthScore: overall relationship health. High = engaged, issues progressing, trust. Low = ignored, unresolved friction, stalled.
- churnRiskScore: likelihood the customer disengages or leaves. Raise when the same complaint repeats across turns or channels; unresolved issues after agent promises; explicit cancel/switch/competitor language; long silence after frustration. Weigh RECENT complaints more heavily than old ones (use As-of / date range in the user message).
- purchaseIntentScore: readiness to buy/upgrade/expand. Raise on pricing, plans, demos, “how do I start”, ROI, timeline-to-buy questions. Lower if purely support/complaint with no commercial interest.
- sentimentScore: −100 (very negative) to +100 (very positive). Weight recent tone more than old. Call transcripts showing frustration, raised conflict, or sarcasm should pull sentiment down more than the same words typed in chat.

Signal weighting:
- Repeated complaints about the SAME issue → meaningfully higher churnRiskScore.
- Pricing / upgrade / demo / “ready to proceed” questions → meaningfully higher purchaseIntentScore.
- Frustrated or tense call tone → stronger negative sentiment / churn signal than equivalent chat text.
- If chat and call contradict, reconcile in summary (which channel is more recent / more emotional) and score the blended truth — do not average blindly.
- Existing contact tags (if provided) are prior CRM labels — use as weak prior context; do not invent scores solely from tags.

Edge cases:
- Very short history or an explicit LOW-SIGNAL note in the user message: still score if genuine, but state in summary that confidence is low due to limited signal.
- Empty painPoints or interests: use [] when none are evidenced — do not invent.
- recommendedAction (when genuine): one concrete next step for the human agent/CS team (not marketing fluff).

Output rules:
- summary: 2–3 sentences when genuine (or 1–2 when non-genuine), plain language, no markdown.
- painPoints / interests: short phrases grounded in the transcript; max ~8 each.
- Be calibrated, not dramatic — reserve extreme scores (≤15 or ≥85) for clear evidence.`;

/**
 * Per-contact user message. System prompt stays identical; only this varies.
 */
export function buildInsightUserMessage(bundle: InsightContextBundle): string {
  const asOf = formatInsightTimestamp(bundle.analyzedAt);
  const asOfIso = bundle.analyzedAt.toISOString();
  const tagsLine = bundle.tags.length > 0 ? bundle.tags.join(', ') : '(none)';

  const rangeLine =
    bundle.earliestAt && bundle.latestAt
      ? `${formatInsightTimestamp(bundle.earliestAt)} → ${formatInsightTimestamp(bundle.latestAt)} (UTC)`
      : '(no dated interactions in window)';

  const lowSignalThreshold = config.contactInsight.lowSignalThreshold;
  const lowSignalNote =
    bundle.interactionCount < lowSignalThreshold
      ? [
          '',
          `LOW-SIGNAL NOTE: Only ${bundle.interactionCount} interaction event(s) (threshold ${lowSignalThreshold}).`,
          'Lower your confidence. Reflect limited evidence explicitly in summary (e.g. “Limited history — confidence is low”).',
          'Avoid extreme scores unless the few events are unambiguous.',
        ].join('\n')
      : '';

  return [
    'Analyze this contact and produce the customer insight scores.',
    '',
    `As-of (UTC): ${asOf} (${asOfIso})`,
    `Contact: ${bundle.contactName} (${bundle.contactId})`,
    `Existing tags: ${tagsLine}`,
    `Interaction date range: ${rangeLine}`,
    `Interaction events: ${bundle.interactionCount}`,
    `Conversations included: ${bundle.conversationIds.length}`,
    `Call transcripts included: ${bundle.callSessionIds.length}`,
    lowSignalNote,
    '',
    '--- INTERACTION HISTORY ---',
    bundle.contextText || '(empty)',
    '--- END ---',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
}

function toUnrecoverable(err: LlmClientError): Error {
  if (
    err.code === 'LLM_NOT_CONFIGURED' ||
    err.code === 'BYOK_CREDENTIALS_MISSING' ||
    err.code === 'BYOK_KEY_MISMATCH' ||
    err.code === 'LLM_STRUCTURED_UNSUPPORTED' ||
    err.code === 'INSIGHT_PROVIDER_UNSUPPORTED'
  ) {
    return new UnrecoverableError(err.message);
  }
  return err;
}

/**
 * Resolve workspace OpenAI (same path as AI Agent), Structured Outputs, then Zod.
 * Transient failures throw (BullMQ retries). Config/provider issues are UnrecoverableError.
 */
export async function runContactInsightLlm(
  bundle: InsightContextBundle
): Promise<ContactInsightLlmResult> {
  const providerService = new AiProviderConfigService(prisma);

  let resolved;
  try {
    resolved = await providerService.resolveForWorkspace(bundle.workspaceId);
  } catch (err) {
    if (err instanceof LlmClientError) throw toUnrecoverable(err);
    throw err;
  }

  if (resolved.provider === 'anthropic') {
    throw new UnrecoverableError(
      'Contact insight requires OpenAI Structured Outputs. Set workspace AI Provider to OpenAI or ConvoSync.'
    );
  }

  const llm = new LlmClient(resolved);
  let content: string;
  try {
    const out = await llm.completeJsonSchema(
      [
        { role: 'system', content: CONTACT_INSIGHT_SYSTEM_PROMPT },
        { role: 'user', content: buildInsightUserMessage(bundle) },
      ],
      CONTACT_INSIGHT_OPENAI_JSON_SCHEMA as unknown as Record<string, unknown>,
      {
        name: 'contact_insight',
        maxTokens: Math.min(resolved.maxOutputTokens, 1200),
        temperature: 0.2,
      }
    );
    content = out.content;
    console.log(
      '[contact-insight] llm ok',
      bundle.contactId,
      `model=${resolved.model}`,
      `tokens=${out.usage.totalTokens}`
    );
  } catch (err) {
    if (err instanceof LlmClientError) {
      console.error('[contact-insight] llm failed', bundle.contactId, err.code, err.message);
      throw toUnrecoverable(err);
    }
    console.error('[contact-insight] llm failed', bundle.contactId, err);
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new LlmClientError('Insight LLM returned invalid JSON', 'INSIGHT_JSON_PARSE', 502);
  }

  const parsed = contactInsightLlmSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('[contact-insight] zod failed', bundle.contactId, parsed.error.message);
    throw new LlmClientError(
      `Insight LLM failed Zod validation: ${parsed.error.message}`,
      'INSIGHT_ZOD_FAILED',
      502
    );
  }

  return parsed.data;
}
