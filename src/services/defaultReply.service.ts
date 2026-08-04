import { prisma } from '../lib/prisma.js';
import { getIo } from '../socket.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';
import { formatMetaSendError, sendWhatsAppMessage } from './whatsapp.js';
import { getWorkspaceInstagramCredentials } from './instagramCredentials.js';
import { formatInstagramSendError, sendInstagramMessage } from './instagram.js';
import { getWorkspaceMessengerCredentials } from './messengerCredentials.js';
import { formatMessengerSendError, sendMessengerMessage } from './messenger.js';
import { parseInstagramScopedUserId, parseMessengerPsid } from '../lib/channelContact.js';
import {
  getWorkspaceAutomationSettings,
  isWorkspaceAutomationsPaused,
} from './workspaceAutomationSettings.service.js';

/**
 * Last-resort fallback when conversation is unassigned and no automation matched.
 * Skips if automations are paused, disabled, empty, or we already replied as default
 * after the contact's latest message.
 */
export async function maybeSendDefaultReply(input: {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  channel: 'whatsapp' | 'instagram' | 'messenger';
}): Promise<boolean> {
  if (await isWorkspaceAutomationsPaused(input.workspaceId)) return false;

  const settings = await getWorkspaceAutomationSettings(input.workspaceId);
  const text = settings?.defaultReplyText?.trim();
  if (!settings?.defaultReplyEnabled || !text) return false;

  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    select: { assigneeType: true, status: true, channelAccountId: true },
  });
  if (!conversation || conversation.status === 'resolved') return false;
  if (conversation.assigneeType) return false;

  const lastMessages = await prisma.message.findMany({
    where: { conversationId: input.conversationId },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { sender: true, metadata: true },
  });
  if (lastMessages[0]?.sender !== 'contact') return false;
  for (const m of lastMessages) {
    if (m.sender === 'contact') break;
    const meta = (m.metadata ?? {}) as { source?: string };
    if (meta.source === 'default_reply') return false;
  }

  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, workspaceId: input.workspaceId },
  });
  if (!contact) return false;

  let messageId: string;
  try {
    if (input.channel === 'whatsapp') {
      const creds = await getWorkspaceWhatsAppCredentials(
        input.workspaceId,
        conversation.channelAccountId
      );
      if (!creds.phoneNumberId) return false;
      const result = await sendWhatsAppMessage(
        creds.accessToken,
        creds.phoneNumberId,
        contact.phone,
        text
      );
      messageId = result.waMessageId;
    } else if (input.channel === 'instagram') {
      const creds = await getWorkspaceInstagramCredentials(
        input.workspaceId,
        conversation.channelAccountId
      );
      const recipientId = parseInstagramScopedUserId(contact.phone);
      if (!recipientId) return false;
      const result = await sendInstagramMessage(
        creds.pageId,
        creds.pageAccessToken,
        recipientId,
        text,
        { instagramUserId: creds.instagramUserId }
      );
      messageId = result.messageId;
    } else {
      const creds = await getWorkspaceMessengerCredentials(
        input.workspaceId,
        conversation.channelAccountId
      );
      const psid = parseMessengerPsid(contact.phone);
      if (!psid) return false;
      const result = await sendMessengerMessage(
        creds.pageId,
        creds.pageAccessToken,
        psid,
        text
      );
      messageId = result.messageId;
    }
  } catch (err) {
    const msg =
      input.channel === 'whatsapp'
        ? formatMetaSendError(err)
        : input.channel === 'instagram'
          ? formatInstagramSendError(err)
          : formatMessengerSendError(err);
    console.warn('[DefaultReply] send failed', msg);
    return false;
  }

  const message = await prisma.message.create({
    data: {
      waMessageId: messageId,
      conversationId: input.conversationId,
      sender: 'agent',
      senderName: 'Default Reply',
      content: text,
      type: 'text',
      status: 'sent',
      metadata: { source: 'default_reply' },
    },
  });

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { lastMessage: text.slice(0, 500), lastMessageAt: new Date() },
  });

  try {
    const io = getIo();
    io.to(input.workspaceId).emit('new_message', {
      conversationId: input.conversationId,
      message,
    });
    io.to(input.workspaceId).emit('conversation_updated', {
      conversationId: input.conversationId,
    });
  } catch {
    // socket optional
  }

  return true;
}
