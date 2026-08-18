import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import { findOrCreateTelegramContact } from '../lib/telegramContact.js';
import { findTelegramAccountByBotId } from './workspaceResolve.js';

function logTelegramWebhook(label: string, payload?: unknown) {
  const line = `[Telegram Webhook] ${label}`;
  if (payload === undefined) {
    console.log(line);
    return;
  }
  console.log(line, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: unknown;
  sticker?: unknown;
  voice?: unknown;
  video?: unknown;
  audio?: unknown;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

function contactNameFromUser(user: TelegramUser | undefined, chat: TelegramChat): string {
  const first = user?.first_name || chat.first_name;
  const last = user?.last_name || chat.last_name;
  const username = user?.username || chat.username;
  const full = [first, last].filter(Boolean).join(' ').trim();
  return full || (username ? `@${username}` : `Telegram user ${chat.id}`);
}

/** Best-effort content for message kinds we don't fully support yet (no media download pipeline). */
function extractContent(message: TelegramMessage): { content: string; kind: 'text' | 'unsupported' } {
  if (message.text) return { content: message.text, kind: 'text' };
  if (message.caption) return { content: message.caption, kind: 'text' };
  if (message.photo) return { content: '[Photo]', kind: 'unsupported' };
  if (message.document) return { content: '[Document]', kind: 'unsupported' };
  if (message.sticker) return { content: '[Sticker]', kind: 'unsupported' };
  if (message.voice) return { content: '[Voice message]', kind: 'unsupported' };
  if (message.video) return { content: '[Video]', kind: 'unsupported' };
  if (message.audio) return { content: '[Audio]', kind: 'unsupported' };
  return { content: '[Unsupported message]', kind: 'unsupported' };
}

export async function handleTelegramUpdate(botId: string, update: TelegramUpdate): Promise<void> {
  const message = update.message || update.edited_message;
  if (!message) {
    logTelegramWebhook('ignored update with no message', { updateId: update.update_id });
    return;
  }

  const account = await findTelegramAccountByBotId(botId);
  if (!account?.workspace) {
    logTelegramWebhook('skip unknown bot', { botId });
    return;
  }
  const workspace = account.workspace;

  // Ignore messages the bot itself sent (shouldn't normally arrive, but be defensive).
  if (message.from?.is_bot && String(message.from.id) === botId) {
    logTelegramWebhook('skip echo from bot', { botId });
    return;
  }

  const chatId = String(message.chat.id);
  const messageId = `tg_${botId}_${message.message_id}`;

  const existing = await prisma.message.findFirst({ where: { waMessageId: messageId } });
  if (existing) {
    logTelegramWebhook('skip duplicate message', { messageId });
    return;
  }

  const contactName = contactNameFromUser(message.from, message.chat);
  const contact = await findOrCreateTelegramContact({
    db: prisma,
    workspaceId: workspace.id,
    chatId,
    name: contactName,
  });

  const { conversation: conv } = await findOrReopenConversationForInbound({
    workspaceId: workspace.id,
    contactId: contact.id,
    channel: 'telegram',
    channelAccountId: botId,
  });

  const { content, kind } = extractContent(message);

  const saved = await prisma.message.create({
    data: {
      waMessageId: messageId,
      conversationId: conv.id,
      sender: 'contact',
      senderName: contactName,
      content,
      type: kind === 'text' ? 'text' : 'unsupported',
    },
  });

  await prisma.conversation.updateMany({
    where: { id: conv.id, workspaceId: workspace.id },
    data: {
      lastMessage: content,
      lastMessageAt: new Date(),
      unreadCount: { increment: 1 },
      channelAccountId: botId,
    },
  });

  getIo().to(workspace.id).emit('new_message', { conversationId: conv.id, message: saved });
  getIo().to(workspace.id).emit('conversation_updated', { conversationId: conv.id });

  logTelegramWebhook('saved message', {
    messageId: saved.id,
    conversationId: conv.id,
    contactId: contact.id,
  });
}
