import axios from 'axios';
import path from 'node:path';
import { normalizeWhatsAppRecipient } from '../lib/phone.js';
import type { SendWhatsAppResult } from './whatsapp.js';
import { getObject, mimeTypeFromStorageKey, putObject } from './objectStorage.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export type WhatsAppMessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location';

export type MessageMediaMetadata = {
  mimeType?: string;
  fileName?: string;
  caption?: string;
  storageKey?: string;
  waMediaId?: string;
  latitude?: number;
  longitude?: number;
  locationName?: string;
  locationAddress?: string;
};

type InboundWebhookMessage = {
  id: string;
  from: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id?: string; mime_type?: string };
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
  };
};

export type ParsedInboundWhatsApp = {
  kind: WhatsAppMessageKind;
  content: string;
  buttonPayload?: string;
  media?: {
    waMediaId: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
  };
  location?: MessageMediaMetadata;
};

export function previewForMessage(kind: WhatsAppMessageKind, content: string, caption?: string): string {
  if (caption?.trim()) return caption.trim();
  if (content.trim() && content !== '[media]') return content.trim();
  switch (kind) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return '🎤 Audio';
    case 'document':
      return '📎 Document';
    case 'sticker':
      return '🎭 Sticker';
    case 'location':
      return '📍 Location';
    default:
      return content.trim() || 'Message';
  }
}

export function parseInboundWhatsAppMessage(msg: InboundWebhookMessage): ParsedInboundWhatsApp {
  const isButtonReply = msg.type === 'interactive' && msg.interactive?.button_reply;
  const buttonPayload =
    msg.interactive?.button_reply?.id || msg.interactive?.button_reply?.title || undefined;

  if (isButtonReply) {
    return {
      kind: 'text',
      content: buttonPayload || '[button]',
      buttonPayload,
    };
  }

  if (msg.type === 'image' && msg.image?.id) {
    return {
      kind: 'image',
      content: msg.image.caption?.trim() || '📷 Photo',
      media: {
        waMediaId: msg.image.id,
        mimeType: msg.image.mime_type,
        caption: msg.image.caption,
      },
    };
  }

  if (msg.type === 'video' && msg.video?.id) {
    return {
      kind: 'video',
      content: msg.video.caption?.trim() || '🎥 Video',
      media: {
        waMediaId: msg.video.id,
        mimeType: msg.video.mime_type,
        caption: msg.video.caption,
      },
    };
  }

  if (msg.type === 'audio' && msg.audio?.id) {
    return {
      kind: 'audio',
      content: '🎤 Audio',
      media: {
        waMediaId: msg.audio.id,
        mimeType: msg.audio.mime_type,
      },
    };
  }

  if (msg.type === 'document' && msg.document?.id) {
    return {
      kind: 'document',
      content: msg.document.caption?.trim() || msg.document.filename || '📎 Document',
      media: {
        waMediaId: msg.document.id,
        mimeType: msg.document.mime_type,
        fileName: msg.document.filename,
        caption: msg.document.caption,
      },
    };
  }

  if (msg.type === 'sticker' && msg.sticker?.id) {
    return {
      kind: 'sticker',
      content: '🎭 Sticker',
      media: {
        waMediaId: msg.sticker.id,
        mimeType: msg.sticker.mime_type || 'image/webp',
      },
    };
  }

  if (msg.type === 'location' && msg.location) {
    const name = msg.location.name?.trim();
    const address = msg.location.address?.trim();
    const label = name || address || '📍 Location';
    return {
      kind: 'location',
      content: label,
      location: {
        latitude: msg.location.latitude,
        longitude: msg.location.longitude,
        locationName: name,
        locationAddress: address,
      },
    };
  }

  const text = msg.text?.body?.trim() || '[media]';
  return { kind: 'text', content: text };
}

function extensionForMime(mimeType: string, fileName?: string): string {
  if (fileName?.includes('.')) {
    return path.extname(fileName).slice(1).toLowerCase() || 'bin';
  }
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || mimeType.split('/')[1]?.split('+')[0] || 'bin';
}

export async function saveMessageMediaFile(
  workspaceId: string,
  messageId: string,
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  const ext = extensionForMime(mimeType, fileName);
  const storageKey = `${workspaceId}/${messageId}.${ext}`;
  await putObject(storageKey, buffer, mimeType);
  return storageKey;
}

export async function readMessageMediaFile(storageKey: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const buffer = await getObject(storageKey);
  return { buffer, mimeType: mimeTypeFromStorageKey(storageKey) };
}

export async function downloadWhatsAppMedia(
  waToken: string,
  waMediaId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaRes = await axios.get(`${GRAPH}/${waMediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  const meta = metaRes.data as { url?: string; mime_type?: string };
  if (!meta.url) {
    throw new Error('Meta did not return a media URL');
  }

  const fileRes = await axios.get(meta.url, {
    headers: { Authorization: `Bearer ${waToken}` },
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType: meta.mime_type || 'application/octet-stream',
  };
}

export function resolveOutboundWhatsAppKind(mimeType: string): Exclude<WhatsAppMessageKind, 'text' | 'location' | 'sticker'> {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

export async function uploadWhatsAppMedia(
  waToken: string,
  phoneNumberId: string,
  buffer: Buffer,
  mimeType: string,
  fileName?: string
): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  const blob = new Blob([buffer], { type: mimeType });
  form.append('file', blob, fileName || `upload.${extensionForMime(mimeType, fileName)}`);

  const res = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${waToken}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || 'Failed to upload media to WhatsApp');
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error('Meta API did not return a media id');
  }
  return data.id;
}

export async function sendWhatsAppMediaMessage(
  waToken: string,
  phoneNumberId: string,
  to: string,
  kind: Exclude<WhatsAppMessageKind, 'text' | 'location' | 'sticker'>,
  waMediaId: string,
  caption?: string,
  fileName?: string
): Promise<SendWhatsAppResult> {
  const recipient = normalizeWhatsAppRecipient(to);
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: kind,
  };

  const mediaPayload: Record<string, unknown> = { id: waMediaId };
  if (caption?.trim() && (kind === 'image' || kind === 'video' || kind === 'document')) {
    mediaPayload.caption = caption.trim();
  }
  if (kind === 'document' && fileName?.trim()) {
    mediaPayload.filename = fileName.trim();
  }
  payload[kind] = mediaPayload;

  const res = await axios.post(`${GRAPH}/${phoneNumberId}/messages`, payload, {
    headers: { Authorization: `Bearer ${waToken}` },
  });

  const data = res.data as {
    messages?: Array<{ id: string }>;
    contacts?: Array<{ wa_id: string }>;
  };

  const waMessageId = data.messages?.[0]?.id;
  if (!waMessageId) {
    throw new Error('Meta API did not return a message id');
  }

  return {
    waMessageId,
    waId: data.contacts?.[0]?.wa_id,
  };
}
