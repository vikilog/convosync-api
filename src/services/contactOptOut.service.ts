import { prisma } from '../index.js';
import { getIo } from '../socket.js';

/** Matches campaignAudience.service.ts's EXCLUDED_TAGS — both exclude a contact from campaigns. */
export const UNSUBSCRIBED_TAG = 'Unsubscribed';
export const BLOCKED_TAG = 'Blocked';

const OPT_OUT_KEYWORDS = new Set([
  'stop',
  'stopall',
  'stop all',
  'unsubscribe',
  'opt out',
  'optout',
  'cancel',
]);

/** Whole-message match only (not a substring check) — avoids false positives like "please don't stop the great service". */
export function isOptOutMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  return OPT_OUT_KEYWORDS.has(normalized);
}

/** Idempotent — returns false if the contact was already tagged (or not found). */
async function addComplianceTag(
  contactId: string,
  workspaceId: string,
  tag: string
): Promise<boolean> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { tags: true },
  });
  if (!contact || contact.tags.includes(tag)) return false;

  const updated = await prisma.contact.update({
    where: { id: contactId },
    data: { tags: Array.from(new Set([...contact.tags, tag])) },
  });
  getIo().to(workspaceId).emit('contact_updated', { contactId, tags: updated.tags });
  return true;
}

/** Explicit "stop messaging me" signal — STOP keyword, spam complaint, in-flow Unsubscribe node. */
export function markContactUnsubscribed(contactId: string, workspaceId: string): Promise<boolean> {
  return addComplianceTag(contactId, workspaceId, UNSUBSCRIBED_TAG);
}

/** Address is undeliverable (hard bounce) rather than a consent withdrawal, but excludes the same way. */
export function markContactBlocked(contactId: string, workspaceId: string): Promise<boolean> {
  return addComplianceTag(contactId, workspaceId, BLOCKED_TAG);
}

/**
 * True if the contact has explicitly opted out or is undeliverable — every
 * pipeline that acts on a contact's behalf (campaigns, AI insight
 * profiling, CRM push) must check this before proceeding.
 */
export function isOptedOutOrBlocked(tags: string[]): boolean {
  return tags.includes(UNSUBSCRIBED_TAG) || tags.includes(BLOCKED_TAG);
}
