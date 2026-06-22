import axios from 'axios';
import type { SendInstagramResult } from './instagram.js';
import {
  type MessageMediaMetadata,
  previewForMessage,
  saveMessageMediaFile,
} from './whatsappMedia.js';

const GRAPH = 'https://graph.facebook.com/v25.0';

export type InstagramAttachmentKind = 'image' | 'video' | 'audio' | 'file';

export type ParsedInboundInstagram = {
  kind: 'text' | 'image' | 'video' | 'audio' | 'document';
  content: string;
  media?: {
    url: string;
    mimeType?: string;
    fileName?: string;
  };
};

type WebhookAttachment = {
  type?: string;
  payload?: {
    url?: string;
    title?: string;
    sticker_id?: number;
  };
};

export function mapInstagramAttachmentType(
  type: string | undefined
): 'image' | 'video' | 'audio' | 'document' | null {
  switch (type) {
    case 'image':
    case 'animated_image':
      return 'image';
    case 'video':
    case 'ig_reel':
    case 'reel':
      return 'video';
    case 'audio':
      return 'audio';
    case 'file':
    case 'share':
      return 'document';
    default:
      return null;
  }
}

export function resolveOutboundInstagramKind(mimeType: string): InstagramAttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

export function parseInboundInstagramMessage(
  text: string | undefined,
  attachments?: WebhookAttachment[]
): ParsedInboundInstagram {
  const trimmed = text?.trim();
  if (trimmed) {
    return { kind: 'text', content: trimmed };
  }

  const attachment = attachments?.[0];
  if (!attachment?.payload?.url) {
    return { kind: 'text', content: '[media]' };
  }

  const mapped = mapInstagramAttachmentType(attachment.type);
  if (!mapped) {
    return { kind: 'text', content: attachment.payload.title?.trim() || '[media]' };
  }

  return {
    kind: mapped,
    content: previewForMessage(mapped, attachment.payload.title?.trim() || '[media]'),
    media: {
      url: attachment.payload.url,
      fileName: attachment.payload.title,
    },
  };
}

export async function downloadInstagramMediaUrl(
  url: string,
  pageAccessToken?: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const headers: Record<string, string> = {};
  if (pageAccessToken) {
    headers.Authorization = `Bearer ${pageAccessToken}`;
  }

  const res = await axios.get(url, {
    headers,
    responseType: 'arraybuffer',
    maxRedirects: 5,
    timeout: 60_000,
  });

  const mimeType =
    (typeof res.headers['content-type'] === 'string'
      ? res.headers['content-type'].split(';')[0]
      : undefined) || 'application/octet-stream';

  return {
    buffer: Buffer.from(res.data),
    mimeType,
  };
}

/** Instagram DMs require a publicly reachable HTTPS media URL (message_attachments is not supported). */
export async function sendInstagramMediaMessage(
  pageId: string,
  pageAccessToken: string,
  recipientInstagramScopedId: string,
  kind: InstagramAttachmentKind,
  mediaUrl: string
): Promise<SendInstagramResult> {
  const res = await axios.post(
    `${GRAPH}/${pageId}/messages`,
    {
      recipient: { id: recipientInstagramScopedId },
      messaging_type: 'RESPONSE',
      message: {
        attachment: {
          type: kind,
          payload: { url: mediaUrl },
        },
      },
    },
    { params: { access_token: pageAccessToken } }
  );

  const messageId = (res.data as { message_id?: string }).message_id;
  if (!messageId) {
    throw new Error('Meta API did not return a message id');
  }

  return { messageId };
}

type GraphMessageAttachment = {
  mime_type?: string;
  name?: string;
  file_url?: string;
  image_data?: { url?: string };
  video_data?: { url?: string };
};

export function parseGraphInstagramMessage(
  text: string | undefined,
  attachments?: { data?: GraphMessageAttachment[] } | GraphMessageAttachment[]
): ParsedInboundInstagram {
  const trimmed = text?.trim();
  if (trimmed) {
    return { kind: 'text', content: trimmed };
  }

  const list = Array.isArray(attachments)
    ? attachments
    : attachments?.data;
  const attachment = list?.[0];
  if (!attachment) {
    return { kind: 'text', content: '[media]' };
  }

  const url =
    attachment.file_url ||
    attachment.image_data?.url ||
    attachment.video_data?.url;
  if (!url) {
    return { kind: 'text', content: attachment.name?.trim() || '[media]' };
  }

  const mime = attachment.mime_type || '';
  let kind: ParsedInboundInstagram['kind'] = 'document';
  if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('audio/')) kind = 'audio';

  return {
    kind,
    content: previewForMessage(kind, attachment.name?.trim() || '[media]'),
    media: {
      url,
      mimeType: mime || undefined,
      fileName: attachment.name,
    },
  };
}

export { previewForMessage, saveMessageMediaFile, type MessageMediaMetadata };
