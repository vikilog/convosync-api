import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { categoryForType, severityForType } from './types.js';

export type EmitNotificationInput = {
  workspaceId: string;
  type: string;
  /** Defaults from type→category map when omitted. */
  category?: string;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
  actorUserId?: string | null;
  targetUserId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export type WorkspaceNotificationPayload = {
  id: string;
  workspaceId: string;
  type: string;
  category: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  targetUserId: string | null;
  metadata: unknown;
  severity: string;
  createdAt: string;
  unread: true;
};

/** Persist a workspace notification and broadcast over Socket.IO. Never throws. */
export async function emitNotification(
  input: EmitNotificationInput
): Promise<WorkspaceNotificationPayload | null> {
  try {
    const category = input.category ?? categoryForType(input.type);
    const row = await prisma.workspaceNotification.create({
      data: {
        workspaceId: input.workspaceId,
        type: input.type,
        category,
        title: input.title,
        message: input.message,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        actorUserId: input.actorUserId ?? null,
        targetUserId: input.targetUserId ?? null,
        metadata: input.metadata ?? undefined,
      },
    });

    const payload: WorkspaceNotificationPayload = {
      id: row.id,
      workspaceId: row.workspaceId,
      type: row.type,
      category: row.category,
      title: row.title,
      message: row.message,
      entityType: row.entityType,
      entityId: row.entityId,
      actorUserId: row.actorUserId,
      targetUserId: row.targetUserId,
      metadata: row.metadata,
      severity: severityForType(row.type),
      createdAt: row.createdAt.toISOString(),
      unread: true,
    };

    try {
      const { getIo } = await import('../../socket.js');
      getIo().to(input.workspaceId).emit('workspace_notification', payload);
    } catch {
      // Socket not ready (tests / early boot) — persist still succeeded
    }

    return payload;
  } catch (err) {
    console.error('[emitNotification] failed', err);
    return null;
  }
}
