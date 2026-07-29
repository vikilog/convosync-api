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
  /** Direct media URL when Meta sends link instead of / without id. */
  mediaUrl?: string;
  latitude?: number;
  longitude?: number;
  locationName?: string;
  locationAddress?: string;
};

type InboundMediaPart = {
  id?: string;
  link?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
};

type InboundWebhookMessage = {
  id: string;
  from: string;
  type?: string;
  text?: { body?: string };
  image?: InboundMediaPart;
  video?: InboundMediaPart;
  audio?: InboundMediaPart;
  document?: InboundMediaPart;
  sticker?: InboundMediaPart;
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  /** Present on Meta `type: "unsupported"` — explains why (code / title / message). */
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
    href?: string;
  }>;
  reaction?: { message_id?: string; emoji?: string };
  contacts?: Array<{
    name?: { formatted_name?: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone?: string; type?: string; wa_id?: string }>;
    emails?: Array<{ email?: string; type?: string }>;
  }>;
  order?: {
    catalog_id?: string;
    text?: string;
    product_items?: Array<{
      product_retailer_id?: string;
      quantity?: number;
      item_price?: number;
      currency?: string;
    }>;
  };
  system?: { body?: string; type?: string; wa_id?: string };
};

export type ParsedInboundWhatsApp = {
  kind: WhatsAppMessageKind;
  content: string;
  buttonPayload?: string;
  /** Meta system notifications render as centered inbox system rows. */
  sender?: 'contact' | 'system';
  reaction?: { emoji?: string; reactedToWaMessageId?: string };
  media?: {
    waMediaId?: string;
    mediaUrl?: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
  };
  location?: MessageMediaMetadata;
};

/** Skip DB persist (still ACK Meta with 200). Only used for genuine `type: "unsupported"`. */
export type ParseInboundWhatsAppResult =
  | { skip: true }
  | ParsedInboundWhatsApp;

export function isSkippedInbound(
  parsed: ParseInboundWhatsAppResult
): parsed is { skip: true } {
  return 'skip' in parsed && parsed.skip === true;
}

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

function mediaFromPart(
  kind: Exclude<WhatsAppMessageKind, 'text' | 'location'>,
  part: InboundMediaPart | undefined,
  fallbackLabel: string
): ParsedInboundWhatsApp | null {
  if (!part) return null;
  const waMediaId = part.id?.trim() || undefined;
  const mediaUrl = part.link?.trim() || undefined;
  if (!waMediaId && !mediaUrl) return null;
  const caption = part.caption?.trim();
  return {
    kind,
    content: caption || fallbackLabel,
    media: {
      waMediaId,
      mediaUrl,
      mimeType: part.mime_type,
      fileName: part.filename,
      caption: part.caption,
    },
  };
}

function formatOrderContent(order: NonNullable<InboundWebhookMessage['order']>): string {
  const items = order.product_items ?? [];
  const lines = items.map((item) => {
    const qty = item.quantity ?? 1;
    const id = item.product_retailer_id?.trim() || 'item';
    if (item.item_price != null && item.currency) {
      return `${qty}× ${id} (${item.currency} ${item.item_price})`;
    }
    return `${qty}× ${id}`;
  });
  const total = items.reduce((sum, item) => {
    const qty = item.quantity ?? 1;
    const price = item.item_price ?? 0;
    return sum + qty * price;
  }, 0);
  const currency = items.find((i) => i.currency)?.currency;
  const summary = lines.length ? lines.join(', ') : 'no items';
  const totalPart =
    currency && items.some((i) => i.item_price != null) ? ` — Total: ${currency} ${total}` : '';
  const note = order.text?.trim();
  return note ? `Order: ${summary}${totalPart}. ${note}` : `Order: ${summary}${totalPart}`;
}

function formatContactsContent(
  contacts: NonNullable<InboundWebhookMessage['contacts']>
): string {
  const summaries = contacts.slice(0, 3).map((c) => {
    const name =
      c.name?.formatted_name?.trim() ||
      [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ').trim() ||
      'Unknown';
    const phone = c.phones?.[0]?.phone?.trim() || c.phones?.[0]?.wa_id?.trim();
    const email = c.emails?.[0]?.email?.trim();
    if (phone) return `${name} (${phone})`;
    if (email) return `${name} (${email})`;
    return name;
  });
  if (summaries.length === 0) return 'Shared contact';
  if (summaries.length === 1) return `Shared contact: ${summaries[0]}`;
  const extra = contacts.length > summaries.length ? ` +${contacts.length - summaries.length} more` : '';
  return `Shared contacts: ${summaries.join('; ')}${extra}`;
}

/**
 * Parse WhatsApp Cloud API / coexistence inbound message.
 * Prefers payload shape (image/video/…) over `type` string — some echoes set type
 * without a usable id, or send `link` instead of `id`.
 * Returns `{ skip: true }` for Meta `type: "unsupported"` (do not persist).
 */
export function parseInboundWhatsAppMessage(
  msg: InboundWebhookMessage
): ParseInboundWhatsAppResult {
  const buttonReply = msg.interactive?.button_reply;
  if ((msg.type === 'interactive' || msg.interactive) && buttonReply) {
    const buttonPayload = buttonReply.id || buttonReply.title || undefined;
    return {
      kind: 'text',
      content: buttonPayload || '[button]',
      buttonPayload,
    };
  }

  const listReply = msg.interactive?.list_reply;
  if ((msg.type === 'interactive' || msg.interactive) && listReply) {
    const buttonPayload = listReply.id || listReply.title || undefined;
    const title = listReply.title?.trim();
    const description = listReply.description?.trim();
    let content = title || buttonPayload || '[list]';
    if (description) content = `${content} — ${description}`;
    return {
      kind: 'text',
      content,
      buttonPayload,
    };
  }

  const image = mediaFromPart('image', msg.image, '📷 Photo');
  if (image) return image;

  const video = mediaFromPart('video', msg.video, '🎥 Video');
  if (video) return video;

  const audio = mediaFromPart('audio', msg.audio, '🎤 Audio');
  if (audio) return audio;

  const document = mediaFromPart(
    'document',
    msg.document,
    msg.document?.filename?.trim() || '📎 Document'
  );
  if (document) return document;

  const sticker = mediaFromPart('sticker', msg.sticker, '🎭 Sticker');
  if (sticker) {
    return {
      ...sticker,
      media: {
        ...sticker.media,
        mimeType: sticker.media?.mimeType || 'image/webp',
      },
    };
  }

  if (msg.type === 'location' || msg.location) {
    const name = msg.location?.name?.trim();
    const address = msg.location?.address?.trim();
    const label = name || address || '📍 Location';
    return {
      kind: 'location',
      content: label,
      location: {
        latitude: msg.location?.latitude,
        longitude: msg.location?.longitude,
        locationName: name,
        locationAddress: address,
      },
    };
  }

  // Typed media without id/link (common on some coexistence stubs) — keep kind for UI.
  if (msg.type === 'image') return { kind: 'image', content: '📷 Photo' };
  if (msg.type === 'video') return { kind: 'video', content: '🎥 Video' };
  if (msg.type === 'audio') return { kind: 'audio', content: '🎤 Audio' };
  if (msg.type === 'document') return { kind: 'document', content: '📎 Document' };
  if (msg.type === 'sticker') return { kind: 'sticker', content: '🎭 Sticker' };

  const text = msg.text?.body?.trim();
  if (text) return { kind: 'text', content: text };

  if (msg.type === 'reaction' || msg.reaction) {
    const emoji = msg.reaction?.emoji?.trim() || '👍';
    const reactedToWaMessageId = msg.reaction?.message_id?.trim() || undefined;
    return {
      kind: 'text',
      content: `${emoji} reacted to a message`,
      reaction: { emoji, reactedToWaMessageId },
    };
  }

  if (msg.type === 'order' || msg.order) {
    return {
      kind: 'text',
      content: msg.order ? formatOrderContent(msg.order) : 'Order received',
    };
  }

  if (msg.type === 'system' || msg.system) {
    const body = msg.system?.body?.trim();
    return {
      kind: 'text',
      content: body || `System: ${msg.system?.type || 'notification'}`,
      sender: 'system',
    };
  }

  if (msg.type === 'contacts' || (Array.isArray(msg.contacts) && msg.contacts.length > 0)) {
    return {
      kind: 'text',
      content: msg.contacts?.length ? formatContactsContent(msg.contacts) : 'Shared contact',
    };
  }

  // Meta couldn't deliver the original content — unrecoverable; do not persist.
  if (msg.type === 'unsupported') {
    console.log('[WhatsAppInbound] skipped unsupported', {
      from: msg.from,
      type: 'unsupported',
      errorCode: msg.errors?.[0]?.code,
    });
    return { skip: true };
  }

  // Never persist bare "[media]" — inbox shows that as a broken placeholder.
  if (msg.type && msg.type !== 'text') {
    console.log('[WhatsAppInbound] unhandled type', { from: msg.from, type: msg.type });
    return { kind: 'text', content: `Unsupported message (${msg.type})` };
  }
  return { kind: 'text', content: 'Message' };
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

/** Download media from a direct HTTPS link (no Graph media id). */
export async function downloadWhatsAppMediaUrl(
  mediaUrl: string,
  waToken?: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const fileRes = await axios.get(mediaUrl, {
    headers: waToken ? { Authorization: `Bearer ${waToken}` } : undefined,
    responseType: 'arraybuffer',
  });
  const mimeType =
    (typeof fileRes.headers['content-type'] === 'string'
      ? fileRes.headers['content-type'].split(';')[0]
      : null) || 'application/octet-stream';
  return { buffer: Buffer.from(fileRes.data), mimeType };
}

export async function fetchAndStoreInboundMedia(params: {
  workspaceId: string;
  messageId: string;
  waToken: string;
  media: NonNullable<ParsedInboundWhatsApp['media']>;
}): Promise<MessageMediaMetadata> {
  const { workspaceId, messageId, waToken, media } = params;
  let downloaded: { buffer: Buffer; mimeType: string };
  if (media.waMediaId) {
    downloaded = await downloadWhatsAppMedia(waToken, media.waMediaId);
  } else if (media.mediaUrl) {
    downloaded = await downloadWhatsAppMediaUrl(media.mediaUrl, waToken);
  } else {
    throw new Error('No WhatsApp media id or url to download');
  }

  const mimeType = downloaded.mimeType || media.mimeType || 'application/octet-stream';
  const storageKey = await saveMessageMediaFile(
    workspaceId,
    messageId,
    downloaded.buffer,
    mimeType,
    media.fileName
  );

  return {
    mimeType,
    fileName: media.fileName,
    caption: media.caption,
    waMediaId: media.waMediaId,
    mediaUrl: media.mediaUrl,
    storageKey,
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
  // Node fetch/Blob: pass Uint8Array (raw Buffer can fail in some runtimes)
  const bytes = new Uint8Array(buffer);
  const blob = new Blob([bytes], { type: mimeType });
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
  return sendWhatsAppMediaPayload(waToken, phoneNumberId, to, kind, {
    id: waMediaId,
    caption,
    filename: fileName,
  });
}

/** Send image/document/video by public HTTPS link (fallback when media upload fails). */
export async function sendWhatsAppMediaByLink(
  waToken: string,
  phoneNumberId: string,
  to: string,
  kind: Exclude<WhatsAppMessageKind, 'text' | 'location' | 'sticker' | 'audio'>,
  link: string,
  caption?: string,
  fileName?: string
): Promise<SendWhatsAppResult> {
  return sendWhatsAppMediaPayload(waToken, phoneNumberId, to, kind, {
    link,
    caption,
    filename: fileName,
  });
}

async function sendWhatsAppMediaPayload(
  waToken: string,
  phoneNumberId: string,
  to: string,
  kind: Exclude<WhatsAppMessageKind, 'text' | 'location' | 'sticker'>,
  media: { id?: string; link?: string; caption?: string; filename?: string }
): Promise<SendWhatsAppResult> {
  const recipient = normalizeWhatsAppRecipient(to);
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: kind,
  };

  const mediaPayload: Record<string, unknown> = {};
  if (media.id) mediaPayload.id = media.id;
  if (media.link) mediaPayload.link = media.link;
  if (media.caption?.trim() && (kind === 'image' || kind === 'video' || kind === 'document')) {
    mediaPayload.caption = media.caption.trim();
  }
  if (kind === 'document' && media.filename?.trim()) {
    mediaPayload.filename = media.filename.trim();
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
