import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';
import type { Prisma } from '@prisma/client';
import {
  isAiAssigneeType,
  type ConversationEventActorType,
  type ConversationEventType,
} from '../types/conversation-event.js';

export type RecordConversationEventInput = {
  conversationId: string;
  workspaceId: string;
  type: ConversationEventType;
  actorType: ConversationEventActorType;
  actorId?: string | null;
  actorName?: string | null;
  metadata?: Record<string, unknown> | null;
  /** When false, skip socket emit (caller batches). Default true. */
  emit?: boolean;
};

export async function recordConversationEvent(input: RecordConversationEventInput) {
  try {
    const event = await prisma.conversationEvent.create({
      data: {
        conversationId: input.conversationId,
        type: input.type,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    if (input.emit !== false) {
      try {
        getIo().to(input.workspaceId).emit('conversation_event', {
          conversationId: input.conversationId,
          event,
        });
      } catch {
        // socket optional during early boot / tests
      }
    }

    return event;
  } catch (err) {
    // ponytail: events must never block AI reply / assign — table may lag migration
    console.warn(
      '[conversation-event] record failed',
      input.type,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Idempotent: first AI outbound reply in a thread. */
export async function ensureAiHandlingStarted(params: {
  conversationId: string;
  workspaceId: string;
  actorId?: string | null;
  actorName?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const existing = await prisma.conversationEvent.findFirst({
      where: { conversationId: params.conversationId, type: 'AI_HANDLING_STARTED' },
      select: { id: true },
    });
    if (existing) return;
  } catch {
    // table may not exist yet
  }

  await recordConversationEvent({
    conversationId: params.conversationId,
    workspaceId: params.workspaceId,
    type: 'AI_HANDLING_STARTED',
    actorType: 'AI_AGENT',
    actorId: params.actorId,
    actorName: params.actorName,
    metadata: params.metadata,
  });
}

export async function listConversationEvents(conversationId: string) {
  return prisma.conversationEvent.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
}

/** Prior AI assignee stored on HUMAN_TAKEOVER, else last AI_ASSIGNED. */
export async function resolvePriorAiAssignee(conversationId: string): Promise<{
  assigneeType: 'ai' | 'ai_agent';
  assigneeId: string | null;
} | null> {
  const takeover = await prisma.conversationEvent.findFirst({
    where: { conversationId, type: 'HUMAN_TAKEOVER' },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  });
  const fromTakeover = readAiAssigneeMeta(takeover?.metadata);
  if (fromTakeover) return fromTakeover;

  const assigned = await prisma.conversationEvent.findFirst({
    where: { conversationId, type: 'AI_ASSIGNED' },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  });
  return readAiAssigneeMeta(assigned?.metadata);
}

function readAiAssigneeMeta(raw: unknown): {
  assigneeType: 'ai' | 'ai_agent';
  assigneeId: string | null;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const meta = raw as Record<string, unknown>;
  const type =
    (typeof meta.previousAssigneeType === 'string' && meta.previousAssigneeType) ||
    (typeof meta.assigneeType === 'string' && meta.assigneeType) ||
    null;
  if (!isAiAssigneeType(type)) return null;
  const id =
    (typeof meta.previousAssigneeId === 'string' && meta.previousAssigneeId) ||
    (typeof meta.assigneeId === 'string' && meta.assigneeId) ||
    null;
  return {
    assigneeType: type as 'ai' | 'ai_agent',
    assigneeId: type === 'ai' ? null : id,
  };
}
