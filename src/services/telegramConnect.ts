import crypto from 'crypto';
import axios from 'axios';
import { prisma } from '../index.js';
import { encryptSecret } from '../lib/field-encryption.js';
import { config } from '../config.js';

export type TelegramConnectResult = {
  botId: string;
  botUsername?: string;
  botName?: string;
  webhookRegistered: boolean;
  webhookError?: string;
};

export class TelegramConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramConnectError';
  }
}

type TelegramGetMeResponse = {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  description?: string;
};

type TelegramApiResponse = {
  ok: boolean;
  result?: unknown;
  description?: string;
};

function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

function telegramErrorDescription(err: unknown): string | undefined {
  return (err as { response?: { data?: { description?: string } } })?.response?.data
    ?.description;
}

/**
 * Validate a bot token against Telegram's Bot API before storing it —
 * getMe is the standard way to confirm a token is live and fetch bot identity.
 */
async function fetchBotIdentity(botToken: string): Promise<TelegramGetMeResponse['result']> {
  let response: TelegramGetMeResponse;
  try {
    const res = await axios.get<TelegramGetMeResponse>(telegramApiUrl(botToken, 'getMe'), {
      timeout: 10000,
    });
    response = res.data;
  } catch (err) {
    throw new TelegramConnectError(
      telegramErrorDescription(err) || 'Could not reach Telegram with that bot token.'
    );
  }

  if (!response.ok || !response.result) {
    throw new TelegramConnectError(response.description || 'Invalid Telegram bot token.');
  }
  if (!response.result.is_bot) {
    throw new TelegramConnectError('That token does not belong to a bot account.');
  }

  return response.result;
}

/**
 * Point Telegram's webhook at our public API for this bot. Requires an HTTPS,
 * publicly reachable BACKEND_PUBLIC_URL — fails harmlessly on localhost dev
 * (bot still connects; messages just won't arrive until a public URL is set).
 */
async function registerTelegramWebhook(
  botToken: string,
  botId: string,
  secret: string
): Promise<{ registered: boolean; error?: string }> {
  const url = `${config.backendPublicUrl}/api/webhook/telegram/${botId}`;
  try {
    const res = await axios.post<TelegramApiResponse>(
      telegramApiUrl(botToken, 'setWebhook'),
      {
        url,
        secret_token: secret,
        allowed_updates: ['message'],
      },
      { timeout: 10000 }
    );
    if (!res.data.ok) {
      return { registered: false, error: res.data.description || 'setWebhook rejected' };
    }
    return { registered: true };
  } catch (err) {
    return {
      registered: false,
      error: telegramErrorDescription(err) || 'Failed to register Telegram webhook',
    };
  }
}

export async function connectTelegramBot(
  workspaceId: string,
  botToken: string
): Promise<TelegramConnectResult> {
  const trimmedToken = botToken.trim();
  if (!trimmedToken) {
    throw new TelegramConnectError('Bot token is required.');
  }

  const identity = await fetchBotIdentity(trimmedToken);
  const botId = String(identity!.id);
  const webhookSecret = crypto.randomBytes(24).toString('hex');

  await prisma.telegramAccount.upsert({
    where: {
      workspaceId_botId: { workspaceId, botId },
    },
    create: {
      workspaceId,
      botId,
      botUsername: identity!.username,
      botName: identity!.first_name,
      botToken: encryptSecret(trimmedToken),
      webhookSecret,
    },
    update: {
      botUsername: identity!.username,
      botName: identity!.first_name,
      botToken: encryptSecret(trimmedToken),
      webhookSecret,
    },
  });

  const webhook = await registerTelegramWebhook(trimmedToken, botId, webhookSecret);

  return {
    botId,
    botUsername: identity!.username,
    botName: identity!.first_name,
    webhookRegistered: webhook.registered,
    webhookError: webhook.error,
  };
}

export async function listTelegramAccounts(workspaceId: string) {
  const rows = await prisma.telegramAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(({ botToken: _token, webhookSecret: _secret, ...rest }) => rest);
}

export class TelegramSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramSendError';
  }
}

export function formatTelegramSendError(err: unknown): string {
  return telegramErrorDescription(err) || (err instanceof Error ? err.message : 'Failed to send Telegram message');
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<{ messageId: string }> {
  const res = await axios.post<TelegramApiResponse & { result?: { message_id: number } }>(
    telegramApiUrl(botToken, 'sendMessage'),
    { chat_id: chatId, text },
    { timeout: 10000 }
  );
  if (!res.data.ok || !res.data.result) {
    throw new TelegramSendError(res.data.description || 'Telegram rejected the message');
  }
  return { messageId: String(res.data.result.message_id) };
}

export type TelegramMediaKind = 'image' | 'video' | 'audio' | 'document';

const TELEGRAM_MEDIA_METHOD: Record<TelegramMediaKind, { method: string; field: string }> = {
  image: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  audio: { method: 'sendAudio', field: 'audio' },
  document: { method: 'sendDocument', field: 'document' },
};

/** Telegram-side limits (not ours) — sendPhoto caps stricter than sendVideo/Document/Audio. */
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;

function assertWithinTelegramSizeLimit(size: number, kind: TelegramMediaKind, fileName: string) {
  const max = kind === 'image' ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_FILE_MAX_BYTES;
  if (size <= max) return;
  const maxMb = (max / (1024 * 1024)).toFixed(0);
  const actualMb = (size / (1024 * 1024)).toFixed(1);
  const noun = kind === 'image' ? 'photos' : `${kind}s`;
  const hint =
    kind === 'image'
      ? 'Send it as a document instead, or compress the image.'
      : 'Try compressing it first.';
  throw new TelegramSendError(
    `${fileName || 'This file'} is ${actualMb}MB — Telegram limits ${noun} to ${maxMb}MB. ${hint}`
  );
}

/** Single-file send — matches sendPhoto/sendVideo/sendAudio/sendDocument. Bot API takes the
 * file directly (multipart), unlike Meta's staged-public-URL flow. */
export async function sendTelegramMedia(
  botToken: string,
  chatId: string,
  kind: TelegramMediaKind,
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  caption?: string
): Promise<{ messageId: string }> {
  assertWithinTelegramSizeLimit(buffer.length, kind, fileName);
  const { method, field } = TELEGRAM_MEDIA_METHOD[kind];

  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption?.trim()) form.append('caption', caption.trim());
  const bytes = new Uint8Array(buffer);
  const blob = new Blob([bytes], { type: mimeType });
  form.append(field, blob, fileName || `upload-${Date.now()}`);

  const res = await fetch(telegramApiUrl(botToken, method), { method: 'POST', body: form });
  const data = (await res.json()) as TelegramApiResponse & { result?: { message_id: number } };

  if (!data.ok || !data.result) {
    throw new TelegramSendError(data.description || 'Telegram rejected the media message');
  }
  return { messageId: String(data.result.message_id) };
}

export type TelegramMediaGroupItem = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  /** Telegram albums only mix photo + video — never document/audio. */
  kind: 'image' | 'video';
};

/**
 * Telegram's album/carousel — sendMediaGroup. Files are attached as multipart
 * parts referenced by `attach://<field>` inside the JSON `media` array; only
 * the first item may carry a caption (Telegram shows it as the album caption).
 */
export async function sendTelegramMediaGroup(
  botToken: string,
  chatId: string,
  items: TelegramMediaGroupItem[],
  caption?: string
): Promise<{ messageIds: string[] }> {
  if (items.length < 2 || items.length > 10) {
    throw new TelegramSendError('A Telegram album needs between 2 and 10 items.');
  }
  for (const item of items) {
    assertWithinTelegramSizeLimit(item.buffer.length, item.kind, item.fileName);
  }

  const form = new FormData();
  form.append('chat_id', chatId);

  const media = items.map((item, index) => {
    const fieldName = `file${index}`;
    const bytes = new Uint8Array(item.buffer);
    const blob = new Blob([bytes], { type: item.mimeType });
    form.append(fieldName, blob, item.fileName || `upload-${index}`);
    return {
      type: item.kind === 'video' ? 'video' : 'photo',
      media: `attach://${fieldName}`,
      ...(index === 0 && caption?.trim() ? { caption: caption.trim() } : {}),
    };
  });
  form.append('media', JSON.stringify(media));

  const res = await fetch(telegramApiUrl(botToken, 'sendMediaGroup'), {
    method: 'POST',
    body: form,
  });
  const data = (await res.json()) as TelegramApiResponse & {
    result?: Array<{ message_id: number }>;
  };

  if (!data.ok || !data.result) {
    throw new TelegramSendError(data.description || 'Telegram rejected the album');
  }
  return { messageIds: data.result.map((m) => String(m.message_id)) };
}
