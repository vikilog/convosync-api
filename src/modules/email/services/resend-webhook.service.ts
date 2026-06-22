import { Webhook } from 'svix';
import { prisma } from '../../../index.js';
import { config } from '../../../config.js';
import type { EmailLogStatus } from '../types/email.types.js';

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 10,
  failed: 10,
};

type ResendWebhookEvent = {
  type: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    bounce?: { message?: string };
    failed?: { reason?: string };
  };
};

function mapResendEventType(type: string): EmailLogStatus | null {
  switch (type) {
    case 'email.sent':
      return 'sent';
    case 'email.delivered':
      return 'delivered';
    case 'email.opened':
      return 'opened';
    case 'email.clicked':
      return 'clicked';
    case 'email.bounced':
      return 'bounced';
    case 'email.failed':
    case 'email.complained':
      return 'failed';
    default:
      return null;
  }
}

function shouldUpdateStatus(current: string, next: EmailLogStatus): boolean {
  if (next === 'bounced' || next === 'failed') return true;
  const cur = STATUS_RANK[current.toLowerCase()] ?? 0;
  const nxt = STATUS_RANK[next] ?? 0;
  return nxt >= cur;
}

function extractErrorMessage(event: ResendWebhookEvent): string | undefined {
  if (event.type === 'email.bounced') {
    return event.data?.bounce?.message ?? 'Email bounced';
  }
  if (event.type === 'email.failed' || event.type === 'email.complained') {
    return event.data?.failed?.reason ?? event.type;
  }
  return undefined;
}

export async function handleResendEmailWebhook(
  rawPayload: string,
  headers: {
    svixId?: string;
    svixTimestamp?: string;
    svixSignature?: string;
  }
): Promise<{ ok: true; updated: boolean; eventType?: string }> {
  const secret = config.email.resendWebhookSecret;
  let event: ResendWebhookEvent;

  if (secret) {
    const wh = new Webhook(secret);
    event = wh.verify(rawPayload, {
      'svix-id': headers.svixId ?? '',
      'svix-timestamp': headers.svixTimestamp ?? '',
      'svix-signature': headers.svixSignature ?? '',
    }) as ResendWebhookEvent;
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('RESEND_WEBHOOK_SECRET is not configured');
  } else {
    event = JSON.parse(rawPayload) as ResendWebhookEvent;
    console.warn('[Resend Webhook] RESEND_WEBHOOK_SECRET unset — accepting unverified payload in dev');
  }

  const emailId = event.data?.email_id;
  if (!emailId) {
    return { ok: true, updated: false, eventType: event.type };
  }

  const nextStatus = mapResendEventType(event.type);
  if (!nextStatus) {
    return { ok: true, updated: false, eventType: event.type };
  }

  const log = await prisma.emailLog.findFirst({
    where: { messageId: emailId },
  });
  if (!log) {
    return { ok: true, updated: false, eventType: event.type };
  }

  if (!shouldUpdateStatus(log.status, nextStatus)) {
    return { ok: true, updated: false, eventType: event.type };
  }

  const errorMessage = extractErrorMessage(event);
  const prevMeta =
    log.metadata && typeof log.metadata === 'object' && !Array.isArray(log.metadata)
      ? (log.metadata as Record<string, unknown>)
      : {};

  await prisma.emailLog.update({
    where: { id: log.id },
    data: {
      status: nextStatus,
      ...(errorMessage ? { errorMessage } : {}),
      metadata: {
        ...prevMeta,
        lastResendEvent: event.type,
        lastResendEventAt: new Date().toISOString(),
      },
    },
  });

  return { ok: true, updated: true, eventType: event.type };
}
