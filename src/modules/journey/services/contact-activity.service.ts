import type { Contact } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';

export type ContactActivity = {
  /** Timestamp of the contact's most recent inbound message (any channel). */
  lastInboundAt: Date | null;
  /** `Message.type` of that inbound message (e.g. "text", "image"). */
  lastInboundType: string | null;
  /** Most recent activity (inbound or outbound) across the contact's conversations. */
  lastActivityAt: Date | null;
};

/**
 * Backs the "Last Interaction" / "Last Seen" / "Last Reply Type" / "Messaging window
 * segment" condition fields. Two small indexed lookups — cheap enough to run per
 * CONDITION node, and the evaluator only calls this once per evaluation (memoized).
 */
export async function getContactActivity(contact: Pick<Contact, 'id'>): Promise<ContactActivity> {
  const [lastInbound, lastConversation] = await Promise.all([
    prisma.message.findFirst({
      where: { sender: 'contact', conversation: { contactId: contact.id } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, type: true },
    }),
    prisma.conversation.findFirst({
      where: { contactId: contact.id },
      orderBy: { lastMessageAt: 'desc' },
      select: { lastMessageAt: true },
    }),
  ]);
  return {
    lastInboundAt: lastInbound?.createdAt ?? null,
    lastInboundType: lastInbound?.type ?? null,
    lastActivityAt: lastConversation?.lastMessageAt ?? null,
  };
}

export async function getWorkspaceTimezone(workspaceId: string): Promise<string> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  return workspace?.timezone?.trim() || 'Asia/Kolkata';
}
