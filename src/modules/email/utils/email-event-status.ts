import type { EmailLogStatus } from '../types/email.types.js';

export const EMAIL_STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 10,
  complained: 10,
  rejected: 10,
  failed: 10,
};

export type EmailDeliveryEvent = {
  type: string;
  at: string;
  detail?: string;
};

export function shouldAdvanceEmailStatus(current: string, next: EmailLogStatus): boolean {
  if (next === 'bounced' || next === 'failed' || next === 'complained' || next === 'rejected') {
    return true;
  }
  const cur = EMAIL_STATUS_RANK[current.toLowerCase()] ?? 0;
  const nxt = EMAIL_STATUS_RANK[next] ?? 0;
  return nxt >= cur;
}

export function appendEmailDeliveryEvent(
  prevMeta: Record<string, unknown>,
  event: EmailDeliveryEvent,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  const prevEvents = Array.isArray(prevMeta.events) ? [...prevMeta.events] : [];
  // ponytail: cap at 40 events — enough for open/click storms; drop oldest if exceeded
  prevEvents.push(event);
  const events = prevEvents.length > 40 ? prevEvents.slice(-40) : prevEvents;
  return { ...prevMeta, ...extras, events };
}
