import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getIo } from '../../socket.js';
import { config } from '../../config.js';
import { buildInsightContext } from './contact-insight.context.js';
import { runContactInsightLlm } from './contact-insight.llm.js';
import { applyInsightTags } from './contact-insight.tags.js';
import type { ContactInsightJobData } from './contact-insight.types.js';

export type ComputeInsightResult =
  | { status: 'created'; insightId: string }
  | { status: 'skipped'; reason: string };

function minGapMs() {
  return config.contactInsight.minGapHours * 60 * 60 * 1000;
}

export async function latestInsightAt(contactId: string): Promise<Date | null> {
  const row = await prisma.contactInsight.findFirst({
    where: { contactId },
    orderBy: { computedAt: 'desc' },
    select: { computedAt: true },
  });
  return row?.computedAt ?? null;
}

/** True if another computation is allowed now (respects min gap). */
export async function canComputeInsightNow(contactId: string): Promise<{
  ok: boolean;
  reason?: string;
  retryAfterMs?: number;
}> {
  const last = await latestInsightAt(contactId);
  if (!last) return { ok: true };
  const elapsed = Date.now() - last.getTime();
  const gap = minGapMs();
  if (elapsed < gap) {
    return { ok: false, reason: 'min_gap', retryAfterMs: gap - elapsed };
  }
  return { ok: true };
}

/**
 * Main worker entry: context → OpenAI Structured Outputs → ContactInsight → tags → socket.
 * LLM / Zod failures throw (BullMQ retries). Skip paths do not insert a row.
 */
export async function computeContactInsight(
  data: ContactInsightJobData
): Promise<ComputeInsightResult> {
  if (!config.contactInsight.enabled) {
    return { status: 'skipped', reason: 'disabled' };
  }

  const contactMeta = await prisma.contact.findFirst({
    where: { id: data.contactId, workspaceId: data.workspaceId },
    select: { id: true, excludeFromInsights: true },
  });
  if (!contactMeta) {
    return { status: 'skipped', reason: 'contact_not_found' };
  }
  if (contactMeta.excludeFromInsights) {
    return { status: 'skipped', reason: 'excluded' };
  }

  const gap = await canComputeInsightNow(data.contactId);
  if (!gap.ok && !data.force) {
    return { status: 'skipped', reason: gap.reason || 'min_gap' };
  }

  const bundle = await buildInsightContext(data.workspaceId, data.contactId);
  if (!bundle) {
    return { status: 'skipped', reason: 'contact_not_found' };
  }

  if (bundle.interactionCount < config.contactInsight.minInteractions) {
    return {
      status: 'skipped',
      reason: `insufficient_interactions:${bundle.interactionCount}`,
    };
  }

  if (!config.contactInsight.llmEnabled) {
    console.log(
      '[contact-insight] context ready, LLM disabled',
      data.contactId,
      `events=${bundle.interactionCount}`,
      `chars=${bundle.contextText.length}`
    );
    return { status: 'skipped', reason: 'llm_disabled' };
  }

  // Throws on timeout / API / Zod → BullMQ retry; no partial ContactInsight row
  const llmResult = await runContactInsightLlm(bundle);

  const insight = await prisma.contactInsight.create({
    data: {
      workspaceId: data.workspaceId,
      contactId: data.contactId,
      isGenuineCustomerInteraction: llmResult.isGenuineCustomerInteraction,
      healthScore: llmResult.healthScore,
      churnRiskScore: llmResult.churnRiskScore,
      purchaseIntentScore: llmResult.purchaseIntentScore,
      sentimentScore: llmResult.sentimentScore,
      summary: llmResult.summary,
      painPoints: llmResult.painPoints as Prisma.InputJsonValue,
      interests: llmResult.interests as Prisma.InputJsonValue,
      recommendedAction: llmResult.recommendedAction,
      basedOnConversationIds: bundle.conversationIds as Prisma.InputJsonValue,
      basedOnCallSessionIds: bundle.callSessionIds as Prisma.InputJsonValue,
      modelVersion: config.contactInsight.modelVersion,
    },
  });

  let tagsAdded: string[] = [];
  if (
    llmResult.isGenuineCustomerInteraction &&
    llmResult.churnRiskScore != null &&
    llmResult.purchaseIntentScore != null
  ) {
    tagsAdded = await applyInsightTags({
      workspaceId: data.workspaceId,
      contactId: data.contactId,
      churnRiskScore: llmResult.churnRiskScore,
      purchaseIntentScore: llmResult.purchaseIntentScore,
    });
  }

  try {
    getIo().to(data.workspaceId).emit('contact_insight_ready', {
      insightId: insight.id,
      contactId: data.contactId,
      isGenuineCustomerInteraction: insight.isGenuineCustomerInteraction,
      healthScore: insight.healthScore,
      churnRiskScore: insight.churnRiskScore,
      purchaseIntentScore: insight.purchaseIntentScore,
      sentimentScore: insight.sentimentScore,
      summary: insight.summary,
      recommendedAction: insight.recommendedAction,
      tagsAdded,
      modelVersion: insight.modelVersion,
      computedAt: insight.computedAt.toISOString(),
    });
  } catch (err) {
    console.warn('[contact-insight] socket emit failed', err);
  }

  return { status: 'created', insightId: insight.id };
}

export function publicInsightPayload(row: {
  id: string;
  contactId: string;
  isGenuineCustomerInteraction: boolean;
  healthScore: number | null;
  churnRiskScore: number | null;
  purchaseIntentScore: number | null;
  sentimentScore: number | null;
  summary: string;
  painPoints: unknown;
  interests: unknown;
  recommendedAction: string | null;
  modelVersion: string;
  computedAt: Date;
  basedOnConversationIds: unknown;
  basedOnCallSessionIds: unknown;
}) {
  return {
    insightId: row.id,
    contactId: row.contactId,
    isGenuineCustomerInteraction: row.isGenuineCustomerInteraction,
    healthScore: row.healthScore,
    churnRiskScore: row.churnRiskScore,
    purchaseIntentScore: row.purchaseIntentScore,
    sentimentScore: row.sentimentScore,
    summary: row.summary,
    painPoints: Array.isArray(row.painPoints) ? (row.painPoints as string[]) : [],
    interests: Array.isArray(row.interests) ? (row.interests as string[]) : [],
    recommendedAction: row.recommendedAction,
    modelVersion: row.modelVersion,
    computedAt: row.computedAt.toISOString(),
    basedOnConversationIds: Array.isArray(row.basedOnConversationIds)
      ? (row.basedOnConversationIds as string[])
      : [],
    basedOnCallSessionIds: Array.isArray(row.basedOnCallSessionIds)
      ? (row.basedOnCallSessionIds as string[])
      : [],
  };
}

export async function getLatestContactInsight(workspaceId: string, contactId: string) {
  const row = await prisma.contactInsight.findFirst({
    where: { workspaceId, contactId },
    orderBy: { computedAt: 'desc' },
  });
  return row ? publicInsightPayload(row) : null;
}

/**
 * Nightly: contacts with new resolved chats or ready transcripts since last insight.
 */
export async function findContactsNeedingInsight(): Promise<
  Array<{ workspaceId: string; contactId: string }>
> {
  const lookback = new Date(Date.now() - config.contactInsight.lookbackDays * 24 * 60 * 60 * 1000);
  const gapAgo = new Date(Date.now() - minGapMs());

  const resolved = await prisma.conversation.findMany({
    where: {
      status: 'resolved',
      updatedAt: { gte: lookback },
    },
    select: { workspaceId: true, contactId: true, updatedAt: true },
    distinct: ['contactId'],
  });

  const calls = await prisma.callSession.findMany({
    where: {
      transcriptStatus: 'ready',
      contactId: { not: null },
      transcriptAt: { gte: lookback },
    },
    select: { workspaceId: true, contactId: true, transcriptAt: true },
    distinct: ['contactId'],
  });

  const byContact = new Map<string, { workspaceId: string; contactId: string; activityAt: Date }>();

  for (const c of resolved) {
    byContact.set(c.contactId, {
      workspaceId: c.workspaceId,
      contactId: c.contactId,
      activityAt: c.updatedAt,
    });
  }
  for (const c of calls) {
    if (!c.contactId) continue;
    const at = c.transcriptAt || new Date(0);
    const prev = byContact.get(c.contactId);
    if (!prev || at > prev.activityAt) {
      byContact.set(c.contactId, {
        workspaceId: c.workspaceId,
        contactId: c.contactId,
        activityAt: at,
      });
    }
  }

  const out: Array<{ workspaceId: string; contactId: string }> = [];
  for (const row of byContact.values()) {
    const last = await latestInsightAt(row.contactId);
    if (last && last >= row.activityAt) continue; // no new activity since last insight
    if (last && last > gapAgo) continue; // still inside min gap
    out.push({ workspaceId: row.workspaceId, contactId: row.contactId });
  }
  return out;
}
