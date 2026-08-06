import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { decryptSecret } from '../lib/field-encryption.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import { formatMessengerContactPhone } from '../lib/channelContact.js';
import { findOrCreateMessengerContact } from '../lib/messengerContact.js';
import {
  fetchMessengerUserProfile,
  resolveMessengerContactName,
} from './messenger.js';
import { findMessengerAccountByPageId } from './workspaceResolve.js';
import { applyMessagingReadReceipt } from './messagingReadReceipt.service.js';
import { routeInboundConversation } from './conversation-inbound-router.service.js';
import {
  downloadInstagramMediaUrl,
  parseInboundInstagramMessage,
  saveMessageMediaFile,
  type MessageMediaMetadata,
  type ParsedInboundInstagram,
} from './instagramMedia.js';

type PageMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    messaging_product?: 'instagram' | 'facebook';
    attachments?: Array<{
      type?: string;
      payload?: { url?: string; title?: string; sticker_id?: number };
    }>;
  };
  postback?: {
    mid?: string;
    payload?: string;
    title?: string;
  };
  read?: {
    mid?: string;
    watermark?: number;
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
  parsed: ParsedInboundInstagram;
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
  const contactName = resolveMessengerContactName(profile, params.senderId);
  const contact = await findOrCreateMessengerContact({
    db: prisma,
    workspaceId: workspace.id,
    psid: params.senderId,
    name: contactName,
    avatar: profile.profile_pic,
  });

  const { conversation: conv } = await findOrReopenConversationForInbound({
    workspaceId: workspace.id,
    contactId: contact.id,
    channel: 'messenger',
    channelAccountId: params.pageId,
  });

  let metadata: MessageMediaMetadata | undefined;
  if (params.parsed.media) {
    metadata = {
      mimeType: params.parsed.media.mimeType,
      fileName: params.parsed.media.fileName,
    };
  }

  const message = await prisma.message.create({
    data: {
      waMessageId: params.messageId,
      conversationId: conv.id,
      sender: 'contact',
      senderName: contactName,
      content: params.parsed.content,
      type: params.parsed.kind,
      metadata: metadata ? (metadata as object) : undefined,
    },
  });

  if (params.parsed.media?.url) {
    try {
      const downloaded = await downloadInstagramMediaUrl(
        params.parsed.media.url,
        params.pageAccessToken
      );
      const storageKey = await saveMessageMediaFile(
        workspace.id,
        message.id,
        downloaded.buffer,
        downloaded.mimeType || params.parsed.media.mimeType || 'application/octet-stream',
        params.parsed.media.fileName
      );
      metadata = {
        ...(metadata ?? {}),
        mimeType: downloaded.mimeType || params.parsed.media.mimeType,
        fileName: params.parsed.media.fileName,
        storageKey,
      };
      await prisma.message.update({
        where: { id: message.id },
        data: { metadata: metadata as object },
      });
      message.metadata = metadata as object;
    } catch (mediaErr) {
      logMessengerWebhook(
        'media download failed',
        mediaErr instanceof Error ? mediaErr.message : mediaErr
      );
    }
  }

  await prisma.conversation.updateMany({
    where: { id: conv.id, workspaceId: workspace.id },
    data: {
      lastMessage: params.parsed.content,
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

  // Same assignee routing as WhatsApp / Instagram (AI Agent / Copilot / rule-based).
  try {
    await routeInboundConversation({
      workspaceId: workspace.id,
      conversationId: conv.id,
      contactId: contact.id,
      contactPhone: contact.phone,
      text: params.parsed.content,
      channel: 'messenger',
    });
  } catch (routeErr) {
    logMessengerWebhook(
      'inbound route failed',
      routeErr instanceof Error ? routeErr.message : routeErr
    );
  }
}

export type PageMessagingWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: PageMessagingEvent[];
  }>;
};

export function isMessengerMessagingEvent(event: PageMessagingEvent): boolean {
  if (event.read?.watermark != null && !event.read?.mid) return true;
  if (event.read?.mid) return false;
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

    const pageAccessToken = decryptSecret(account.pageAccessToken);
    if (!pageAccessToken) {
      logMessengerWebhook('skip account missing page token', { pageId });
      continue;
    }

    for (const event of entry.messaging || []) {
      if (!isMessengerMessagingEvent(event)) continue;

      const senderId = event.sender?.id;
      if (!senderId) continue;

      if (event.read) {
        const watermark = event.read.watermark;
        if (watermark == null) {
          logMessengerWebhook('skip read without watermark', { read: event.read });
          continue;
        }
        const contactPhone = formatMessengerContactPhone(senderId);
        const contact = await prisma.contact.findFirst({
          where: { phone: contactPhone, workspaceId: account.workspaceId },
          select: { id: true },
        });
        if (!contact) {
          logMessengerWebhook('read: contact not found', { senderId });
          continue;
        }
        const conv = await prisma.conversation.findFirst({
          where: {
            workspaceId: account.workspaceId,
            contactId: contact.id,
            channel: 'messenger',
          },
          orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
          select: { id: true },
        });
        if (!conv) {
          logMessengerWebhook('read: conversation not found', { contactId: contact.id });
          continue;
        }
        await applyMessagingReadReceipt({
          channel: 'messenger',
          workspaceId: account.workspaceId,
          conversationId: conv.id,
          watermarkMs: watermark,
          log: logMessengerWebhook,
        });
        continue;
      }

      if (senderId === account.pageId) continue;

      if (event.postback?.payload) {
        const mid =
          event.postback.mid?.trim() ||
          `postback_${senderId}_${event.timestamp ?? Date.now()}`;
        const parsed = parseInboundInstagramMessage(event.postback.payload.trim());
        await upsertMessengerInboundMessage({
          pageId: account.pageId,
          senderId,
          messageId: mid,
          parsed,
          pageAccessToken,
        });
        continue;
      }

      const message = event.message;
      if (!message?.mid) continue;
      if (message.is_echo) continue;

      const parsed = parseInboundInstagramMessage(message.text, message.attachments);
      await upsertMessengerInboundMessage({
        pageId: account.pageId,
        senderId,
        messageId: message.mid,
        parsed,
        pageAccessToken,
      });
    }
  }
}

export { logMessengerWebhook };
