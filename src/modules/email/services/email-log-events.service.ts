import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { getIo } from '../../../socket.js';
import type { EmailLogStatus } from '../types/email.types.js';
import {
  appendEmailDeliveryEvent,
  mapEmailLogStatusToMessageStatus,
  shouldAdvanceEmailStatus,
} from '../utils/email-event-status.js';

export async function applyEmailLogProviderEvent(input: {
  messageId: string;
  status: EmailLogStatus;
  eventType: string;
  detail?: string;
  metaKey: string;
}): Promise<{ ok: true; updated: boolean; eventType: string }> {
  const log = await prisma.emailLog.findFirst({
    where: { messageId: input.messageId },
  });
  if (!log) {
    return { ok: true, updated: false, eventType: input.eventType };
  }

  const prevMeta =
    log.metadata && typeof log.metadata === 'object' && !Array.isArray(log.metadata)
      ? ({ ...(log.metadata as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const at = new Date().toISOString();
  const metadata = appendEmailDeliveryEvent(
    prevMeta,
    {
      type: input.status,
      at,
      ...(input.detail ? { detail: input.detail } : {}),
    },
    {
      [input.metaKey]: input.eventType,
      [`${input.metaKey}At`]: at,
    }
  ) as Prisma.InputJsonValue;

  const advance = shouldAdvanceEmailStatus(log.status, input.status);
  await prisma.emailLog.update({
    where: { id: log.id },
    data: {
      ...(advance ? { status: input.status } : {}),
      ...(input.detail &&
      (input.status === 'bounced' ||
        input.status === 'failed' ||
        input.status === 'complained' ||
        input.status === 'rejected')
        ? { errorMessage: input.detail }
        : {}),
      metadata,
    },
  });

  await syncInboxMessageFromEmailEvent({
    emailLogId: log.id,
    providerMessageId: input.messageId,
    status: input.status,
    detail: input.detail,
    at,
  });

  return { ok: true, updated: true, eventType: input.eventType };
}

/**
 * Mirror Resend/SES delivery events onto Conversation Message (ticks + click flag).
 * Linked via waMessageId (= provider messageId) or metadata.emailLogId from inbox send.
 */
async function syncInboxMessageFromEmailEvent(input: {
  emailLogId: string;
  providerMessageId: string;
  status: EmailLogStatus;
  detail?: string;
  at: string;
}): Promise<void> {
  let message = await prisma.message.findFirst({
    where: { waMessageId: input.providerMessageId },
    include: { conversation: { select: { workspaceId: true } } },
  });
  if (!message) {
    message = await prisma.message.findFirst({
      where: { metadata: { path: ['emailLogId'], equals: input.emailLogId } },
      include: { conversation: { select: { workspaceId: true } } },
    });
  }
  if (!message?.conversation?.workspaceId) return;

  const prevMeta =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? ({ ...(message.metadata as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const prevEmailStatus =
    typeof prevMeta.emailStatus === 'string' ? prevMeta.emailStatus : message.status;
  const advance = shouldAdvanceEmailStatus(prevEmailStatus, input.status);
  const msgStatus = mapEmailLogStatusToMessageStatus(input.status);
  const clicked = input.status === 'clicked' || prevMeta.clicked === true;

  const nextMeta = appendEmailDeliveryEvent(
    prevMeta,
    {
      type: input.status,
      at: input.at,
      ...(input.detail ? { detail: input.detail } : {}),
    },
    {
      emailStatus: advance ? input.status : prevEmailStatus,
      ...(clicked ? { clicked: true } : {}),
      ...(input.status === 'clicked' && input.detail ? { lastClickUrl: input.detail } : {}),
      ...(input.detail &&
      (input.status === 'bounced' ||
        input.status === 'failed' ||
        input.status === 'complained' ||
        input.status === 'rejected')
        ? { sendError: input.detail }
        : {}),
    }
  ) as Prisma.InputJsonValue;

  if (advance || clicked) {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        ...(advance ? { status: msgStatus } : {}),
        metadata: nextMeta,
      },
    });
  }

  if (!advance && !clicked) return;

  try {
    getIo().to(message.conversation.workspaceId).emit('message_status', {
      messageId: message.id,
      status: advance ? msgStatus : message.status,
      ...(clicked ? { clicked: true } : {}),
      ...(input.detail && msgStatus === 'failed'
        ? {
            errors: [{ message: input.detail }],
          }
        : {}),
    });
  } catch {
    // ponytail: webhooks can run before Socket.IO is up in some boot paths / checks
  }
}
