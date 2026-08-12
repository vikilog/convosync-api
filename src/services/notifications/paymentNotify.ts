import type { Prisma } from '@prisma/client';
import { emitNotification } from './emitNotification.js';
import { NOTIFICATION_TYPES } from './types.js';

export function formatPaymentAmount(amountPaise: number, currency: string): string {
  const major = (Number(amountPaise) || 0) / 100;
  const cur = (currency || 'INR').toUpperCase();
  if (cur === 'INR') {
    return `₹${major.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }
  if (cur === 'USD') {
    return `$${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${major.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${cur}`;
}

export function paymentLabelFromInvoice(invoice: {
  type: string;
  description?: string | null;
  metadata?: Prisma.JsonValue | null;
}): string {
  if (invoice.type === 'wallet_topup') return 'Wallet top-up';
  const meta =
    invoice.metadata && typeof invoice.metadata === 'object' && !Array.isArray(invoice.metadata)
      ? (invoice.metadata as Record<string, unknown>)
      : null;
  if (typeof meta?.planName === 'string' && meta.planName.trim()) return meta.planName.trim();
  if (invoice.description?.trim()) return invoice.description.trim();
  if (invoice.type === 'plan_purchase') return 'Plan purchase';
  if (invoice.type === 'subscription') return 'Subscription renewal';
  if (invoice.type === 'custom_plan') return 'Custom plan';
  if (invoice.type === 'addon' || invoice.type.startsWith('addon')) return 'Add-on';
  return 'Payment';
}

/** Persist + socket bell for payment success/fail. Never throws. */
export async function notifyPaymentOutcome(input: {
  workspaceId: string;
  success: boolean;
  label: string;
  amountPaise: number;
  currency: string;
  entityType?: string | null;
  entityId?: string | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  const amount = formatPaymentAmount(input.amountPaise, input.currency);
  const title = input.success ? 'Payment successful' : 'Payment failed';
  const message = input.success
    ? `${input.label} — ${amount} paid successfully.`
    : input.reason
      ? `${input.label} — ${amount} failed (${input.reason}).`
      : `${input.label} — ${amount} payment failed.`;

  await emitNotification({
    workspaceId: input.workspaceId,
    type: input.success
      ? NOTIFICATION_TYPES.PAYMENT_SUCCESS
      : NOTIFICATION_TYPES.PAYMENT_FAILED,
    title,
    message,
    entityType: input.entityType ?? 'payment',
    entityId: input.entityId ?? null,
    forBell: true,
    metadata: {
      label: input.label,
      amountPaise: input.amountPaise,
      currency: input.currency,
      success: input.success,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.metadata && typeof input.metadata === 'object'
        ? (input.metadata as Record<string, unknown>)
        : {}),
    },
  });
}
