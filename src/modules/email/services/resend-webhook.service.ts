import { Webhook } from 'svix';
import { config } from '../../../config.js';
import type { EmailLogStatus } from '../types/email.types.js';
import { applyEmailLogProviderEvent } from './email-log-events.service.js';
import { markContactUnsubscribed } from '../../../services/contactOptOut.service.js';

type ResendWebhookEvent = {
  type: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    bounce?: { message?: string };
    failed?: { reason?: string };
    click?: { link?: string };
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
    case 'email.complained':
      return 'complained';
    case 'email.failed':
      return 'failed';
    default:
      return null;
  }
}

function extractErrorMessage(event: ResendWebhookEvent): string | undefined {
  if (event.type === 'email.bounced') {
    return event.data?.bounce?.message ?? 'Email bounced';
  }
  if (event.type === 'email.complained') {
    return 'Complaint received';
  }
  if (event.type === 'email.failed') {
    return event.data?.failed?.reason ?? event.type;
  }
  if (event.type === 'email.clicked' && event.data?.click?.link) {
    return event.data.click.link;
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

  const result = await applyEmailLogProviderEvent({
    messageId: emailId,
    status: nextStatus,
    eventType: event.type,
    detail: extractErrorMessage(event),
    metaKey: 'lastResendEvent',
  });

  // A complaint is an explicit "stop emailing me" signal that previously
  // never touched the Contact row, leaving the address eligible for every
  // future campaign indefinitely. (Resend's webhook payload here doesn't
  // expose a hard/soft bounce distinction the way SES's does, so — unlike
  // the SES handler — bounces aren't auto-blocked from this provider.)
  if (nextStatus === 'complained' && result.contactId && result.workspaceId) {
    await markContactUnsubscribed(result.contactId, result.workspaceId);
  }

  return result;
}
