import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import type { InsightContextBundle, InsightContextEvent } from './contact-insight.types.js';

function messageDirection(sender: string): InsightContextEvent['direction'] {
  if (sender === 'contact') return 'inbound';
  if (sender === 'agent' || sender === 'bot' || sender === 'system') return 'outbound';
  return 'unknown';
}

/** UTC `YYYY-MM-DD HH:mm` for stable labels across hosts */
export function formatInsightTimestamp(d: Date): string {
  const iso = d.toISOString(); // 2026-07-10T14:32:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Clear source + direction + time so the model can weigh call tone vs chat text.
 * Examples:
 *   [Chat - inbound - 2026-07-10 14:32]
 *   [Call transcript - outbound - 2026-07-12 09:15]
 */
export function formatInsightEventLabel(
  kind: 'chat' | 'call',
  direction: InsightContextEvent['direction'],
  at: Date
): string {
  const when = formatInsightTimestamp(at);
  if (kind === 'call') {
    return `[Call transcript - ${direction} - ${when}]`;
  }
  return `[Chat - ${direction} - ${when}]`;
}

/**
 * Last N conversations (capped) within lookback days + ready call transcripts,
 * interleaved chronologically into one context string with clear source labels.
 */
export async function buildInsightContext(
  workspaceId: string,
  contactId: string
): Promise<InsightContextBundle | null> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: { id: true, name: true, workspaceId: true, tags: true },
  });
  if (!contact) return null;

  const since = new Date(
    Date.now() - config.contactInsight.lookbackDays * 24 * 60 * 60 * 1000
  );
  const maxConv = config.contactInsight.maxConversations;
  const maxCalls = config.contactInsight.maxCallTranscripts;
  const analyzedAt = new Date();

  const conversations = await prisma.conversation.findMany({
    where: {
      workspaceId,
      contactId,
      OR: [{ lastMessageAt: { gte: since } }, { updatedAt: { gte: since } }],
    },
    orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    take: maxConv,
    select: { id: true },
  });

  const conversationIds = conversations.map((c) => c.id);
  const events: InsightContextEvent[] = [];

  if (conversationIds.length > 0) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId: { in: conversationIds },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        conversationId: true,
        sender: true,
        content: true,
        createdAt: true,
      },
    });

    for (const m of messages) {
      const text = (m.content || '').trim();
      if (!text) continue;
      const direction = messageDirection(m.sender);
      events.push({
        at: m.createdAt,
        kind: 'chat',
        id: m.id,
        conversationId: m.conversationId,
        direction,
        label: formatInsightEventLabel('chat', direction, m.createdAt),
        text: text.slice(0, 4000),
      });
    }
  }

  const calls = await prisma.callSession.findMany({
    where: {
      workspaceId,
      contactId,
      transcriptStatus: 'ready',
      transcriptText: { not: null },
      OR: [
        { transcriptAt: { gte: since } },
        { endedAt: { gte: since } },
        { createdAt: { gte: since } },
      ],
    },
    orderBy: [{ transcriptAt: 'desc' }, { endedAt: 'desc' }],
    take: maxCalls,
    select: {
      id: true,
      conversationId: true,
      direction: true,
      transcriptText: true,
      transcriptAt: true,
      endedAt: true,
      createdAt: true,
    },
  });

  const callSessionIds: string[] = [];
  for (const call of calls) {
    const text = (call.transcriptText || '').trim();
    if (!text) continue;
    callSessionIds.push(call.id);
    const direction =
      call.direction === 'inbound'
        ? 'inbound'
        : call.direction === 'outbound'
          ? 'outbound'
          : 'unknown';
    const at = call.transcriptAt || call.endedAt || call.createdAt;
    events.push({
      at,
      kind: 'call',
      id: call.id,
      conversationId: call.conversationId ?? undefined,
      callSessionId: call.id,
      direction,
      label: formatInsightEventLabel('call', direction, at),
      text: text.slice(0, 12_000),
    });
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const earliestAt = events[0]?.at ?? null;
  const latestAt = events.length ? events[events.length - 1]!.at : null;

  // Timeline only — metadata (tags, date range, as-of) lives in the user message template
  const contextText = events.map((e) => `${e.label} ${e.text}`).join('\n');

  return {
    contactId: contact.id,
    workspaceId: contact.workspaceId,
    contactName: contact.name,
    tags: contact.tags ?? [],
    events,
    conversationIds: [
      ...new Set(events.map((e) => e.conversationId).filter(Boolean) as string[]),
    ],
    callSessionIds,
    interactionCount: events.length,
    earliestAt,
    latestAt,
    analyzedAt,
    contextText,
  };
}
