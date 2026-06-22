import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import { formatMessengerContactPhone } from '../lib/channelContact.js';
import {
  fetchMessengerUserProfile,
  resolveMessengerContactName,
} from './messenger.js';
import { findMessengerAccountByPageId } from './workspaceResolve.js';

type PageMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    messaging_product?: 'instagram' | 'facebook';
  };
};

function logMessengerWebhook(label: string, payload: unknown) {
  const line = `[Messenger Webhook] ${label}`;
  console.log(line, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

export async function upsertMessengerInboundMessage(params: {
  pageId: string;
  senderId: string;
  messageId: string;
  text: string;
  pageAccessToken: string;
}) {
  const account = await findMessengerAccountByPageId(params.pageId);
  if (!account?.workspace) {
    logMessengerWebhook('skip unknown page', { pageId: params.pageId });
    return;
  }
  const workspace = account.workspace;

  const existing = await prisma.message.findFirst({
    where: { waMessageId: params.messageId },
  });
  if (existing) {
    logMessengerWebhook('skip duplicate message', { messageId: params.messageId });
    return;
  }

  const profile = await fetchMessengerUserProfile(params.senderId, params.pageAccessToken);
  const contactPhone = formatMessengerContactPhone(params.senderId);
  const contactName = resolveMessengerContactName(profile, params.senderId);

  let contact = await prisma.contact.findFirst({
    where: { phone: contactPhone, workspaceId: workspace.id },
  });

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name: contactName,
        phone: contactPhone,
        workspaceId: workspace.id,
        source: 'Messenger',
        avatar: profile.profile_pic,
      },
    });
  } else {
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        name: contact.name === contactPhone ? contactName : contact.name,
        avatar: contact.avatar || profile.profile_pic || undefined,
      },
    });
  }

  const { conversation: conv } = await findOrReopenConversationForInbound({
    workspaceId: workspace.id,
    contactId: contact.id,
    channel: 'messenger',
    channelAccountId: params.pageId,
  });

  const message = await prisma.message.create({
    data: {
      waMessageId: params.messageId,
      conversationId: conv.id,
      sender: 'contact',
      senderName: contactName,
      content: params.text,
    },
  });

  await prisma.conversation.updateMany({
    where: { id: conv.id, workspaceId: workspace.id },
    data: {
      lastMessage: params.text,
      lastMessageAt: new Date(),
      unreadCount: { increment: 1 },
      channelAccountId: params.pageId,
    },
  });

  getIo().to(workspace.id).emit('new_message', { conversationId: conv.id, message });
  getIo().to(workspace.id).emit('conversation_updated', { conversationId: conv.id });

  logMessengerWebhook('saved message', {
    messageId: message.id,
    conversationId: conv.id,
    contactId: contact.id,
  });
}

export type PageMessagingWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: PageMessagingEvent[];
  }>;
};

export function isMessengerMessagingEvent(event: PageMessagingEvent): boolean {
  const product = event.message?.messaging_product;
  if (product === 'instagram') return false;
  if (product === 'facebook') return true;
  return true;
}

export async function handleMessengerWebhookBody(body: PageMessagingWebhookBody) {
  if (body.object !== 'page') {
    logMessengerWebhook('ignored object', { object: body.object });
    return;
  }

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    if (!pageId) continue;

    const account = await findMessengerAccountByPageId(pageId);
    if (!account) {
      logMessengerWebhook('skip unregistered page', { pageId });
      continue;
    }

    for (const event of entry.messaging || []) {
      if (!isMessengerMessagingEvent(event)) continue;

      const senderId = event.sender?.id;
      const message = event.message;
      if (!senderId || !message?.mid) continue;
      if (message.is_echo) continue;
      if (senderId === account.pageId) continue;

      const text = message.text?.trim() || '[media]';
      await upsertMessengerInboundMessage({
        pageId: account.pageId,
        senderId,
        messageId: message.mid,
        text,
        pageAccessToken: account.pageAccessToken,
      });
    }
  }
}

export { logMessengerWebhook };
