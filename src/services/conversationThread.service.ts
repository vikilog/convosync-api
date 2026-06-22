import type { Conversation } from '@prisma/client';
import { prisma } from '../index.js';
import { getIo } from '../socket.js';

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
}

function accountScope(channelAccountId?: string | null) {
  return channelAccountId ? { channelAccountId } : {};
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
        data: { channelAccountId: params.channelAccountId },
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
 * Outbound WhatsApp (Pay, campaigns): attach to the contact's active inbox thread when possible,
 * instead of creating a parallel conversation scoped only by phone_number_id.
 */
export async function resolveWhatsAppConversationForOutbound(
  params: FindOrReopenParams
): Promise<{ conversation: Conversation; reopened: boolean; created: boolean }> {
  const channel = params.channel ?? 'whatsapp';

  const open = await prisma.conversation.findFirst({
    where: {
      contactId: params.contactId,
      workspaceId: params.workspaceId,
      channel,
      status: { not: 'resolved' },
    },
    orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
  });

  if (open) {
    if (params.channelAccountId && open.channelAccountId !== params.channelAccountId) {
      const conversation = await prisma.conversation.update({
        where: { id: open.id },
        data: { channelAccountId: params.channelAccountId },
      });
      return { conversation, reopened: false, created: false };
    }
    return { conversation: open, reopened: false, created: false };
  }

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
    contact?: { id?: string } | null;
  },
>(convs: T[]): T[] {
  const byKey = new Map<string, T>();

  for (const conv of convs) {
    const key = conversationInboxKey(conv);
    if (!key) continue;
    const existing = byKey.get(key);
    byKey.set(key, existing ? (pickPreferredConversation(existing, conv) as T) : conv);
  }

  return Array.from(byKey.values());
}

export { conversationRecency };
