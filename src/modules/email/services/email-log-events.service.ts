import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import type { EmailLogStatus } from '../types/email.types.js';
import {
  appendEmailDeliveryEvent,
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

  return { ok: true, updated: true, eventType: input.eventType };
}
