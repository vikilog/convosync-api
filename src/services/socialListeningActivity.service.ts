import { prisma } from '../index.js';
import type { Prisma } from '@prisma/client';

export type SocialActivityEventType =
  | 'auto_dm'
  | 'auto_ignore'
  | 'auto_escalate'
  | 'manual_approve_dm'
  | 'dm_failed'
  | 'dm_sent'
  | 'lead_created'
  | 'classified';

export async function logSocialListeningActivity(input: {
  workspaceId: string;
  eventType: SocialActivityEventType;
  message: string;
  relatedCommentId?: string | null;
  relatedLeadId?: string | null;
  meta?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await prisma.socialListeningActivity.create({
      data: {
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        message: input.message.slice(0, 500),
        relatedCommentId: input.relatedCommentId || null,
        relatedLeadId: input.relatedLeadId || null,
        meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    console.warn('[social.activity] log failed', {
      eventType: input.eventType,
      error: err instanceof Error ? err.message : err,
    });
  }
}

export async function listSocialListeningActivity(
  workspaceId: string,
  limit = 30
) {
  const take = Math.min(Math.max(limit, 1), 100);
  const rows = await prisma.socialListeningActivity.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    message: r.message,
    relatedCommentId: r.relatedCommentId,
    relatedLeadId: r.relatedLeadId,
    meta: r.meta,
    createdAt: r.createdAt.toISOString(),
  }));
}
