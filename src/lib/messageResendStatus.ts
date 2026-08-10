/**
 * Status transitions for inbox messages + campaign email logs on resend.
 * failed → resend_pending → resent | failed (retryCount already bumped at start)
 */

export const RESENDABLE_STATUSES = new Set(['failed', 'bounced', 'rejected']);

export type ResendTerminalStatus = 'resent' | 'failed';

export function canResendStatus(status: string): boolean {
  return RESENDABLE_STATUSES.has(status.toLowerCase());
}

export function beginResend(retryCount: number): {
  status: 'resend_pending';
  retryCount: number;
} {
  return { status: 'resend_pending', retryCount: retryCount + 1 };
}

export function finishResend(ok: boolean): ResendTerminalStatus {
  return ok ? 'resent' : 'failed';
}

/** Insights: treat resent as delivered-ish success; resend_pending as in-flight. */
export function classifyDeliveryStatus(status: string): 'failed' | 'pending' | 'success' | 'other' {
  const s = status.toLowerCase();
  if (s === 'failed' || s === 'bounced' || s === 'rejected') return 'failed';
  if (s === 'resend_pending' || s === 'queued' || s === 'sending') return 'pending';
  if (s === 'resent' || s === 'sent' || s === 'delivered' || s === 'read' || s === 'opened' || s === 'clicked') {
    return 'success';
  }
  return 'other';
}

export function mergeSendErrorMetadata(
  existing: unknown,
  sendError: string
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  base.sendError = sendError;
  return base;
}
