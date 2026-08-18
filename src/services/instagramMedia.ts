import axios from 'axios';
import {
  isInstagramOutsideMessagingWindow,
  type SendInstagramResult,
} from './instagram.js';
import {
  type MessageMediaMetadata,
  previewForMessage,
  saveMessageMediaFile,
} from './whatsappMedia.js';
import { ssrfSafeRequestAgents } from '../utils/ssrfGuard.js';

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
    case 'sticker':
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

function inferKindFromWebhookAttachment(
  attachment: WebhookAttachment
): ParsedInboundInstagram['kind'] {
  if (attachment.payload?.sticker_id) return 'image';
  return 'document';
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
  if (!attachment) {
    return { kind: 'image', content: previewForMessage('image', '') };
  }

  const mapped =
    mapInstagramAttachmentType(attachment.type) ?? inferKindFromWebhookAttachment(attachment);
  const title = attachment.payload?.title?.trim() || '';
  const url = attachment.payload?.url?.trim();
  if (!url) {
    // Story share / reel / sticker without fetchable URL — typed preview, not "[media]".
    return { kind: mapped, content: previewForMessage(mapped, title) };
  }

  return {
    kind: mapped,
    content: previewForMessage(mapped, title),
    media: {
      url,
      fileName: attachment.payload?.title,
    },
  };
}

/**
 * The attachment URL comes straight from webhook payload content (Instagram
 * DM or Messenger), so it's attacker-suppliable in principle — fetched
 * through the same pinned-DNS/private-IP SSRF guard used for outbound
 * journey webhooks, with redirects disabled so a redirect can't hop to an
 * internal address after the initial host check passes.
 */
export async function downloadInstagramMediaUrl(
  url: string,
  pageAccessToken?: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const headers: Record<string, string> = {};
  if (pageAccessToken) {
    headers.Authorization = `Bearer ${pageAccessToken}`;
  }

  const { httpAgent, httpsAgent } = await ssrfSafeRequestAgents(url);
  const res = await axios.get(url, {
    headers,
    responseType: 'arraybuffer',
    maxRedirects: 0,
    timeout: 60_000,
    httpAgent,
    httpsAgent,
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
  const recipient = { id: recipientInstagramScopedId };
  const message = {
    attachment: {
      type: kind,
      payload: { url: mediaUrl },
    },
  };

  const post = async (payload: Record<string, unknown>) => {
    const res = await axios.post(`${GRAPH}/${pageId}/messages`, payload, {
      params: { access_token: pageAccessToken },
    });
    const messageId = (res.data as { message_id?: string }).message_id;
    if (!messageId) {
      throw new Error('Meta API did not return a message id');
    }
    return { messageId };
  };

  try {
    return await post({
      recipient,
      messaging_type: 'RESPONSE',
      message,
    });
  } catch (err) {
    if (!isInstagramOutsideMessagingWindow(err)) throw err;
    return await post({
      recipient,
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
      message,
    });
  }
}

export type InstagramTemplateElement = {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  /** Single web_url button — postback buttons aren't wired to the journey engine. */
  buttonTitle?: string;
  buttonUrl?: string;
};

/**
 * Messenger Platform "generic template" — same Send API endpoint as text/media, just a
 * different attachment payload. IG Messaging accepts it for card (1 element) and horizontally
 * scrollable gallery (2-10 elements) content.
 */
export async function sendInstagramTemplateMessage(
  pageId: string,
  pageAccessToken: string,
  recipientInstagramScopedId: string,
  elements: InstagramTemplateElement[]
): Promise<SendInstagramResult> {
  const recipient = { id: recipientInstagramScopedId };
  const message = {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'generic',
        elements: elements.slice(0, 10).map((el) => ({
          title: el.title.trim().slice(0, 80),
          ...(el.subtitle?.trim() ? { subtitle: el.subtitle.trim().slice(0, 80) } : {}),
          ...(el.imageUrl ? { image_url: el.imageUrl } : {}),
          ...(el.buttonUrl && el.buttonTitle?.trim()
            ? {
                buttons: [
                  { type: 'web_url', url: el.buttonUrl, title: el.buttonTitle.trim().slice(0, 20) },
                ],
              }
            : {}),
        })),
      },
    },
  };

  const post = async (payload: Record<string, unknown>) => {
    const res = await axios.post(`${GRAPH}/${pageId}/messages`, payload, {
      params: { access_token: pageAccessToken },
    });
    const messageId = (res.data as { message_id?: string }).message_id;
    if (!messageId) {
      throw new Error('Meta API did not return a message id');
    }
    return { messageId };
  };

  try {
    return await post({ recipient, messaging_type: 'RESPONSE', message });
  } catch (err) {
    if (!isInstagramOutsideMessagingWindow(err)) throw err;
    return await post({ recipient, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', message });
  }
}

type GraphMessageAttachment = {
  id?: string;
  mime_type?: string;
  name?: string;
  file_url?: string;
  image_data?: {
    url?: string;
    preview_url?: string;
    animated_gif_url?: string;
    width?: number;
    height?: number;
    render_as_sticker?: boolean;
  };
  video_data?: {
    url?: string;
    preview_url?: string;
    width?: number;
    height?: number;
  };
};

function graphAttachmentUrl(attachment: GraphMessageAttachment): string | undefined {
  return (
    attachment.file_url?.trim() ||
    attachment.image_data?.url?.trim() ||
    attachment.image_data?.animated_gif_url?.trim() ||
    attachment.image_data?.preview_url?.trim() ||
    attachment.video_data?.url?.trim() ||
    attachment.video_data?.preview_url?.trim() ||
    undefined
  );
}

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
    // Empty Meta message body with no attachment payload (share/story stub, etc.)
    return { kind: 'image', content: previewForMessage('image', '') };
  }

  const url = graphAttachmentUrl(attachment);
  const mime = attachment.mime_type || '';
  let kind: ParsedInboundInstagram['kind'] = 'document';
  if (mime.startsWith('image/') || attachment.image_data) {
    kind = 'image';
  } else if (mime.startsWith('video/') || attachment.video_data) {
    kind = 'video';
  } else if (mime.startsWith('audio/')) {
    kind = 'audio';
  }

  const title = attachment.name?.trim() || '';
  if (!url) {
    // Attachment present but CDN URL missing — keep typed preview, not bare "[media]".
    return { kind, content: previewForMessage(kind, title) };
  }

  return {
    kind,
    content: previewForMessage(kind, title),
    media: {
      url,
      mimeType: mime || undefined,
      fileName: attachment.name,
    },
  };
}

export { previewForMessage, saveMessageMediaFile, type MessageMediaMetadata };
