import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { resolveWorkspaceByPhoneNumberId } from './workspaceResolve.js';

/** Cap stored JSON so huge media-adjacent payloads don't bloat the table. */
export const WEBHOOK_PAYLOAD_MAX_CHARS = 32_000;

export function truncateJsonPayload(payload: unknown): Prisma.InputJsonValue | undefined {
  if (payload === undefined) return undefined;
  try {
    const raw = JSON.stringify(payload);
    if (raw == null) return undefined;
    if (raw.length <= WEBHOOK_PAYLOAD_MAX_CHARS) {
      return payload as Prisma.InputJsonValue;
    }
    // ponytail: ceiling = 32k preview; upgrade = object storage / sampling
    return {
      _truncated: true,
      chars: raw.length,
      preview: raw.slice(0, WEBHOOK_PAYLOAD_MAX_CHARS),
    };
  } catch {
    return { _error: 'unserializable' };
  }
}

type MetaWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
    messaging?: unknown[];
  }>;
};

export function describeMetaWebhook(body: MetaWebhookBody): {
  source: string;
  eventType: string;
  object: string | null;
  summary: string;
  phoneNumberId: string | null;
} {
  const object = body?.object ?? null;

  if (object === 'page' || object === 'instagram') {
    const entry = body.entry?.[0];
    const changeField = entry?.changes?.[0]?.field;
    const hasMessaging = Array.isArray(entry?.messaging) && entry!.messaging!.length > 0;
    const eventType = changeField || (hasMessaging ? 'messaging' : 'webhook');
    return {
      source: object === 'instagram' ? 'instagram' : 'messenger',
      eventType,
      object,
      summary: `${object} ${eventType}`,
      phoneNumberId: null,
    };
  }

  const change = body?.entry?.[0]?.changes?.[0];
  const field = change?.field ?? 'unknown';
  const value = (change?.value ?? {}) as Record<string, unknown>;
  const metadata = value.metadata as { phone_number_id?: string } | undefined;
  const phoneNumberId = metadata?.phone_number_id ?? null;

  const statuses = value.statuses as
    | Array<{
        status?: string;
        recipient_id?: string;
        errors?: Array<{ code?: number; message?: string; title?: string }>;
      }>
    | undefined;
  const messages = value.messages as Array<{ type?: string; from?: string }> | undefined;

  let eventType = field;
  if (statuses?.[0] && !messages?.[0] && field === 'messages') {
    eventType = 'statuses';
  }

  let summary = field;
  if (statuses?.[0]) {
    const s = statuses[0];
    const err = s.errors?.[0];
    summary = err
      ? `status=${s.status ?? '?'} error=${err.code ?? '?'} ${err.message || err.title || ''}`.trim()
      : `status=${s.status ?? '?'} recipient=${s.recipient_id ?? ''}`;
  } else if (messages?.[0]) {
    summary = `inbound type=${messages[0].type ?? '?'} from=${messages[0].from ?? '?'}`;
  } else if (field === 'message_template_status_update') {
    const name = (value.message_template_name || value.message_template_id || '?') as string;
    const st = (value.event || value.message_template_status || '?') as string;
    summary = `template=${name} status=${st}`;
  }

  return {
    source: 'whatsapp',
    eventType,
    object,
    summary,
    phoneNumberId,
  };
}

export async function recordWebhookEventLog(input: {
  source: string;
  eventType: string;
  object?: string | null;
  workspaceId?: string | null;
  summary?: string | null;
  payload?: unknown;
  error?: string | null;
}): Promise<void> {
  try {
    const row = await prisma.webhookEventLog.create({
      data: {
        source: input.source,
        eventType: input.eventType,
        object: input.object ?? null,
        workspaceId: input.workspaceId ?? null,
        summary: input.summary ? input.summary.slice(0, 500) : null,
        payload: truncateJsonPayload(input.payload),
        error: input.error ? input.error.slice(0, 2000) : null,
      },
    });

    // Live refresh for Super Admin webhook logs (platform room)
    try {
      const { getIo, PLATFORM_ROOM } = await import('../socket.js');
      getIo().to(PLATFORM_ROOM).emit('platform_webhook_event', {
        id: row.id,
        source: row.source,
        eventType: row.eventType,
        object: row.object,
        workspaceId: row.workspaceId,
        summary: row.summary,
        error: row.error,
        receivedAt: row.receivedAt.toISOString(),
      });
    } catch {
      // Socket not ready — persist still succeeded
    }
  } catch (err) {
    console.error('[webhookEventLog] persist failed', err);
  }
}

/**
 * Best-effort: describe + resolve workspace + insert. Never throws.
 *
 * This is an admin-visible AUDIT LOG only — it does not gate or dedupe
 * anything. Real inbound-message dedup happens per-handler via a
 * findFirst-by-waMessageId check backed by Message.waMessageId's DB-level
 * @unique constraint (see routes/webhooks.ts, instagramWebhookHandler.ts,
 * messengerWebhookHandler.ts, whatsappCoexistenceWebhook.ts).
 */
export async function recordInboundMetaWebhook(
  body: MetaWebhookBody,
  opts?: { error?: string | null }
): Promise<void> {
  const desc = describeMetaWebhook(body);
  let workspaceId: string | null = null;
  if (desc.phoneNumberId) {
    try {
      const ws = await resolveWorkspaceByPhoneNumberId(desc.phoneNumberId);
      workspaceId = ws?.id ?? null;
    } catch {
      // ignore resolve failures — still log the event
    }
  }
  await recordWebhookEventLog({
    source: desc.source,
    eventType: desc.eventType,
    object: desc.object,
    workspaceId,
    summary: desc.summary,
    payload: body,
    error: opts?.error,
  });
}

type RazorpayWebhookBody = {
  entity?: string;
  event?: string;
  account_id?: string;
  payload?: {
    payment?: { entity?: Record<string, unknown> };
    subscription?: { entity?: Record<string, unknown> };
    payment_link?: { entity?: Record<string, unknown> };
    invoice?: { entity?: Record<string, unknown> };
    [key: string]: unknown;
  };
  created_at?: number;
};

function notesWorkspaceId(notes: unknown): string | null {
  if (!notes || typeof notes !== 'object') return null;
  const n = notes as Record<string, unknown>;
  const id = n.workspaceId ?? n.workspace_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function describeRazorpayWebhook(body: RazorpayWebhookBody): {
  source: string;
  eventType: string;
  object: string | null;
  summary: string;
  workspaceId: string | null;
} {
  const eventType = typeof body?.event === 'string' && body.event ? body.event : 'unknown';
  const payload = body?.payload ?? {};
  const payment = payload.payment?.entity;
  const subscription = payload.subscription?.entity;
  const paymentLink = payload.payment_link?.entity;
  const invoice = payload.invoice?.entity;

  const workspaceId =
    notesWorkspaceId(payment?.notes) ??
    notesWorkspaceId(paymentLink?.notes) ??
    notesWorkspaceId(subscription?.notes) ??
    null;

  const parts: string[] = [];
  if (payment && typeof payment.id === 'string') {
    parts.push(`payment=${payment.id}`);
    if (typeof payment.status === 'string') parts.push(`status=${payment.status}`);
    if (typeof payment.amount === 'number') {
      const cur = typeof payment.currency === 'string' ? payment.currency : '';
      parts.push(`amount=${payment.amount}${cur ? ` ${cur}` : ''}`);
    }
    if (typeof payment.error_description === 'string' && payment.error_description) {
      parts.push(`err=${payment.error_description}`);
    }
  } else if (subscription && typeof subscription.id === 'string') {
    parts.push(`subscription=${subscription.id}`);
    if (typeof subscription.status === 'string') parts.push(`status=${subscription.status}`);
  } else if (paymentLink && typeof paymentLink.id === 'string') {
    parts.push(`payment_link=${paymentLink.id}`);
    if (typeof paymentLink.status === 'string') parts.push(`status=${paymentLink.status}`);
    const notes = paymentLink.notes as Record<string, unknown> | undefined;
    if (typeof notes?.purpose === 'string') parts.push(`purpose=${notes.purpose}`);
  } else if (invoice && typeof invoice.id === 'string') {
    parts.push(`invoice=${invoice.id}`);
    if (typeof invoice.status === 'string') parts.push(`status=${invoice.status}`);
  }

  return {
    source: 'razorpay',
    eventType,
    object: typeof body?.entity === 'string' ? body.entity : 'event',
    summary: parts.length ? parts.join(' ') : eventType,
    workspaceId,
  };
}

/** Best-effort Razorpay audit log. Never throws. */
export async function recordInboundRazorpayWebhook(
  body: RazorpayWebhookBody | null | undefined,
  opts?: { error?: string | null; payload?: unknown; duplicate?: boolean }
): Promise<void> {
  if (body && typeof body.event === 'string') {
    const desc = describeRazorpayWebhook(body);
    const summary = opts?.duplicate ? `${desc.summary} (duplicate)` : desc.summary;
    await recordWebhookEventLog({
      source: desc.source,
      eventType: desc.eventType,
      object: desc.object,
      workspaceId: desc.workspaceId,
      summary,
      payload: opts?.payload ?? body,
      error: opts?.error,
    });
    return;
  }
  await recordWebhookEventLog({
    source: 'razorpay',
    eventType: 'invalid',
    object: 'event',
    summary: 'unparseable or rejected webhook',
    payload: opts?.payload ?? body ?? null,
    error: opts?.error ?? 'invalid payload',
  });
}

export async function listWebhookEventLogs(opts: {
  page: number;
  pageSize: number;
  source?: string;
  eventType?: string;
}) {
  const where: Prisma.WebhookEventLogWhereInput = {};
  if (opts.source) where.source = opts.source;
  if (opts.eventType) where.eventType = opts.eventType;

  const [total, items] = await Promise.all([
    prisma.webhookEventLog.count({ where }),
    prisma.webhookEventLog.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / opts.pageSize));

  return {
    items: items.map((row) => ({
      id: row.id,
      source: row.source,
      eventType: row.eventType,
      object: row.object,
      workspaceId: row.workspaceId,
      summary: row.summary,
      payload: row.payload,
      error: row.error,
      receivedAt: row.receivedAt.toISOString(),
    })),
    pagination: {
      page: opts.page,
      pageSize: opts.pageSize,
      total,
      totalPages,
    },
  };
}
