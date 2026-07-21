import type { Conversation } from '@prisma/client';
import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import {
  normalizeWhatsAppContactPhone,
  whatsappCanonicalDigits,
  whatsappInboxPhoneKey,
} from '../lib/whatsappContact.js';

type FindOrReopenParams = {
  workspaceId: string;
  contactId: string;
  channel?: string;
  channelAccountId?: string | null;
};

function conversationRecency(conv: Conversation): number {
  const ts = conv.lastMessageAt ?? conv.updatedAt ?? conv.createdAt;
  return ts.getTime();
}

export async function clearFlowSessionForConversation(conversationId: string): Promise<void> {
  await prisma.agentFlowSession.deleteMany({ where: { conversationId } });
}

export async function onConversationResolved(conversationId: string): Promise<void> {
  await clearFlowSessionForConversation(conversationId);
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true, contactId: true },
  });
  if (!conv) return;
  const { enqueueContactInsight } = await import('../queue/contact-insight.queue.js');
  void enqueueContactInsight({
    workspaceId: conv.workspaceId,
    contactId: conv.contactId,
    reason: 'conversation_resolved',
  }).catch((err) => console.warn('[contact-insight] enqueue on resolve failed', err));
}

function accountScope(channelAccountId?: string | null) {
  return {
    ...(channelAccountId ? { channelAccountId } : {}),
  };
}

/**
 * One thread per contact + channel + inbox account (e.g. each WhatsApp phone_number_id).
 */
export async function findOrReopenConversationForInbound(
  params: FindOrReopenParams
): Promise<{ conversation: Conversation; reopened: boolean; created: boolean }> {
  const channel = params.channel ?? 'whatsapp';
  const scope = accountScope(params.channelAccountId);

  const open = await prisma.conversation.findFirst({
    where: {
      contactId: params.contactId,
      workspaceId: params.workspaceId,
      channel,
      status: { not: 'resolved' },
      ...scope,
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  if (open) {
    if (params.channelAccountId && !open.channelAccountId) {
      const conversation = await prisma.conversation.update({
        where: { id: open.id },
        data: {
          channelAccountId: params.channelAccountId,
        },
      });
      return { conversation, reopened: false, created: false };
    }
    return { conversation: open, reopened: false, created: false };
  }

  const latest = await prisma.conversation.findFirst({
    where: {
      contactId: params.contactId,
      workspaceId: params.workspaceId,
      channel,
      ...scope,
    },
    orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
  });

  if (latest) {
    if (latest.status === 'resolved') {
      const conversation = await prisma.conversation.update({
        where: { id: latest.id },
        data: {
          status: 'open',
          ...(params.channelAccountId ? { channelAccountId: params.channelAccountId } : {}),
        },
      });
      await clearFlowSessionForConversation(latest.id);
      getIo().to(params.workspaceId).emit('conversation_updated', { conversationId: latest.id });
      return { conversation, reopened: true, created: false };
    }
    return { conversation: latest, reopened: false, created: false };
  }

  const conversation = await prisma.conversation.create({
    data: {
      contactId: params.contactId,
      workspaceId: params.workspaceId,
      channel,
      ...(params.channelAccountId ? { channelAccountId: params.channelAccountId } : {}),
    },
  });

  return { conversation, reopened: false, created: true };
}

/**
 * Outbound WhatsApp (Pay, campaigns): same account-scoped thread as inbound.
 * Do not steal another connected number's open conversation.
 */
export async function resolveWhatsAppConversationForOutbound(
  params: FindOrReopenParams
): Promise<{ conversation: Conversation; reopened: boolean; created: boolean }> {
  return findOrReopenConversationForInbound(params);
}

function conversationInboxKey(conv: {
  id?: string;
  channelAccountId?: string | null;
  contact?: { id?: string } | null;
}): string {
  const contactId = conv.contact?.id;
  if (!contactId) return '';
  const accountId = conv.channelAccountId ? String(conv.channelAccountId) : '';
  return accountId ? `${contactId}:${accountId}` : `${contactId}:${conv.id ?? ''}`;
}

/** Pick one inbox row when duplicate rows exist for the same contact + inbox account. */
export function pickPreferredConversation(
  a: { status?: string; lastMessageAt?: Date | string | null },
  b: { status?: string; lastMessageAt?: Date | string | null }
) {
  const rank = (status?: string) => (status === 'resolved' ? 0 : 1);
  const rankA = rank(a.status);
  const rankB = rank(b.status);
  if (rankA !== rankB) return rankA > rankB ? a : b;

  const time = (conv: { lastMessageAt?: Date | string | null }) => {
    const raw = conv.lastMessageAt;
    if (!raw) return 0;
    const parsed = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  return time(a) >= time(b) ? a : b;
}

export function dedupeConversationsByContact<
  T extends {
    id?: string;
    status?: string;
    lastMessageAt?: Date | string | null;
    channelAccountId?: string | null;
    channel?: string;
    contact?: { id?: string; phone?: string } | null;
  },
>(convs: T[]): T[] {
  const byKey = new Map<string, T>();

  for (const conv of convs) {
    const key = whatsappInboxDedupeKey(conv);
    if (!key) continue;
    const existing = byKey.get(key);
    byKey.set(key, existing ? (pickPreferredConversation(existing, conv) as T) : conv);
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const time = (conv: { lastMessageAt?: Date | string | null }) => {
      const raw = conv.lastMessageAt;
      if (!raw) return 0;
      const parsed = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return time(b) - time(a);
  });
}

/** One inbox row per customer phone + WhatsApp business number (phone_number_id). */
export function whatsappInboxDedupeKey(conv: {
  id?: string;
  channel?: string;
  channelAccountId?: string | null;
  contact?: { id?: string; phone?: string } | null;
}): string {
  if (conv.channel !== 'whatsapp') {
    return conversationInboxKey(conv);
  }

  const contactPhone = conv.contact?.phone ?? '';
  if (contactPhone && !contactPhone.startsWith('lid:') && !contactPhone.startsWith('group:')) {
    const phoneKey = whatsappInboxPhoneKey(contactPhone);
    if (phoneKey) {
      const accountId = (conv.channelAccountId || '').trim();
      // Scope by business number so Cloud API + Coexistence lines stay separate.
      return accountId ? `${phoneKey}:${accountId}` : phoneKey;
    }
  }

  return conversationInboxKey(conv);
}

export async function mergeConversationInto(keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) return;
  await prisma.agentFlowSession.deleteMany({ where: { conversationId: dropId } });
  await prisma.message.updateMany({
    where: { conversationId: dropId },
    data: { conversationId: keepId },
  });
  await prisma.conversation.delete({ where: { id: dropId } });
}

/**
 * Permanent dedup: merge duplicate WhatsApp contacts + conversations for the same phone.
 */
export async function consolidateWorkspaceWhatsAppDuplicates(
  workspaceId: string,
  options?: { channelAccountId?: string }
): Promise<{ mergedContacts: number; mergedConversations: number; removedGroups: number }> {
  let mergedContacts = 0;
  let mergedConversations = 0;
  let removedGroups = 0;

  const contacts = await prisma.contact.findMany({ where: { workspaceId } });
  const phoneBuckets = new Map<string, typeof contacts>();
  for (const contact of contacts) {
    if (contact.phone.startsWith('lid:') || contact.phone.startsWith('group:')) continue;
    const bucket = whatsappCanonicalDigits(contact.phone);
    if (!bucket) continue;
    const list = phoneBuckets.get(bucket) ?? [];
    list.push(contact);
    phoneBuckets.set(bucket, list);
  }

  for (const [, group] of phoneBuckets) {
    if (group.length <= 1) continue;
    const scored = await Promise.all(
      group.map(async (contact) => ({
        contact,
        conversationCount: await prisma.conversation.count({
          where: { contactId: contact.id },
        }),
      }))
    );
    scored.sort((a, b) => {
      if (b.conversationCount !== a.conversationCount) {
        return b.conversationCount - a.conversationCount;
      }
      return a.contact.createdAt.getTime() - b.contact.createdAt.getTime();
    });
    const primary = scored[0]!.contact;
    for (let i = 1; i < scored.length; i++) {
      const dup = scored[i]!.contact;
      await prisma.conversation.updateMany({
        where: { contactId: dup.id },
        data: { contactId: primary.id },
      });
      await prisma.journeyExecution.updateMany({
        where: { contactId: dup.id },
        data: { contactId: primary.id },
      });
      await prisma.agentFlowSession.updateMany({
        where: { contactId: dup.id },
        data: { contactId: primary.id },
      });
      await prisma.contact.delete({ where: { id: dup.id } });
      mergedContacts++;
    }
    const normalized = normalizeWhatsAppContactPhone(primary.phone);
    if (primary.phone !== normalized) {
      await prisma.contact.update({
        where: { id: primary.id },
        data: { phone: normalized },
      });
    }
  }

  const convWhere = {
    workspaceId,
    channel: 'whatsapp',
    ...(options?.channelAccountId ? { channelAccountId: options.channelAccountId } : {}),
  };

  const groupConvs = await prisma.conversation.findMany({
    where: {
      ...convWhere,
      contact: { phone: { startsWith: 'group:' } },
    },
    select: { id: true },
  });
  for (const g of groupConvs) {
    await prisma.agentFlowSession.deleteMany({ where: { conversationId: g.id } });
    await prisma.message.deleteMany({ where: { conversationId: g.id } });
    await prisma.conversation.delete({ where: { id: g.id } });
    removedGroups++;
  }

  const convs = await prisma.conversation.findMany({
    where: {
      ...convWhere,
      contact: { phone: { not: { startsWith: 'group:' } } },
    },
    include: { contact: true },
    orderBy: { lastMessageAt: 'desc' },
  });

  const convBuckets = new Map<string, typeof convs>();
  for (const conv of convs) {
    const key = whatsappInboxDedupeKey(conv);
    if (!key.startsWith('wa:')) continue;
    const list = convBuckets.get(key) ?? [];
    list.push(conv);
    convBuckets.set(key, list);
  }

  for (const [, group] of convBuckets) {
    if (group.length <= 1) continue;
    let keeper = group[0]!;
    for (let i = 1; i < group.length; i++) {
      keeper = pickPreferredConversation(keeper, group[i]!) as (typeof convs)[0];
    }
    for (const dup of group) {
      if (dup.id === keeper.id) continue;
      await mergeConversationInto(keeper.id, dup.id);
      mergedConversations++;
    }
  }

  return { mergedContacts, mergedConversations, removedGroups };
}

export { conversationRecency };
