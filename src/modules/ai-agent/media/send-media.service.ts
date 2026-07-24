import type { MediaAsset } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { getIo } from '../../../socket.js';
import { getRelevantMedia } from '../../media-gallery/get-relevant-media.js';
import {
  MEDIA_DUPLICATE_WINDOW_MS,
  excludeRecentlySent,
} from '../../media-gallery/media-match.js';
import {
  mediaTypeFromMime,
  readMediaGalleryFile,
} from '../../media-gallery/media-storage.js';
import {
  previewForMessage,
  resolveOutboundWhatsAppKind,
  sendWhatsAppMediaByLink,
  sendWhatsAppMediaMessage,
  uploadWhatsAppMedia,
} from '../../../services/whatsappMedia.js';
import {
  buildMediaOfferLine,
  clearPendingMediaOffer,
  setPendingMediaOffer,
  shouldAutoSendMedia,
} from './media-offer.js';

export type SendMediaResult =
  | { status: 'sent'; mediaId: string; waMessageId: string }
  | { status: 'offered'; mediaId: string; offerLine: string }
  | {
      status: 'skipped';
      reason: 'no_assets' | 'no_match' | 'already_shared' | 'no_file' | 'error';
      mediaId?: string;
      detail?: string;
    };

export type MediaPlan =
  | { kind: 'send'; asset: MediaAsset }
  | { kind: 'offer'; asset: MediaAsset; offerLine: string }
  | {
      kind: 'skip';
      reason: 'no_assets' | 'no_match' | 'already_shared' | 'no_file' | 'error';
      detail?: string;
      mediaId?: string;
    };

async function recentlySentMediaIds(conversationId: string): Promise<Set<string>> {
  const since = new Date(Date.now() - MEDIA_DUPLICATE_WINDOW_MS);
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      sender: 'agent',
      createdAt: { gte: since },
    },
    select: { metadata: true },
    take: 100,
  });
  const ids = new Set<string>();
  for (const row of rows) {
    const meta = row.metadata as { mediaAssetId?: string } | null;
    if (meta?.mediaAssetId) ids.add(meta.mediaAssetId);
  }
  return ids;
}

export async function loadAgentMediaAsset(
  workspaceId: string,
  mediaId: string
): Promise<MediaAsset | null> {
  return prisma.mediaAsset.findFirst({
    where: { id: mediaId, workspaceId, isActive: true },
  });
}

/** Pick + decide: auto-send (pricing/explicit) vs ask-first (feature/Q&A). */
export async function planAgentMediaAttachment(params: {
  workspaceId: string;
  conversationId: string;
  query: string;
  intent: string;
  audience?: 'customer' | 'partner';
  mediaId?: string;
}): Promise<MediaPlan> {
  try {
    let asset: MediaAsset | null = null;

    if (params.mediaId) {
      asset = await loadAgentMediaAsset(params.workspaceId, params.mediaId);
      if (!asset) return { kind: 'skip', reason: 'no_match', mediaId: params.mediaId };
    } else {
      const picked = await getRelevantMedia(
        params.workspaceId,
        params.query,
        params.audience ?? 'customer',
        'agent'
      );
      if (picked.reason === 'no_assets') return { kind: 'skip', reason: 'no_assets' };
      if (picked.reason === 'error') {
        return { kind: 'skip', reason: 'error', detail: picked.detail };
      }
      if (!picked.match) return { kind: 'skip', reason: 'no_match' };
      asset = picked.match;
    }

    const recentIds = await recentlySentMediaIds(params.conversationId);
    if (recentIds.has(asset.id) || excludeRecentlySent([asset], recentIds).length === 0) {
      return { kind: 'skip', reason: 'already_shared', mediaId: asset.id };
    }
    if (!asset.storageKey) return { kind: 'skip', reason: 'no_file', mediaId: asset.id };

    if (shouldAutoSendMedia(params.intent) || params.mediaId) {
      return { kind: 'send', asset };
    }

    const offerLine = buildMediaOfferLine(asset.title, asset.type);
    await setPendingMediaOffer(params.workspaceId, params.conversationId, {
      mediaId: asset.id,
      title: asset.title,
      type: asset.type,
    });
    return { kind: 'offer', asset, offerLine };
  } catch (err) {
    return {
      kind: 'skip',
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Send a specific Media Gallery asset over WhatsApp. */
export async function sendAgentMediaAsset(params: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  contactPhone: string;
  accessToken: string;
  phoneNumberId: string;
  asset: MediaAsset;
}): Promise<SendMediaResult> {
  try {
    const { asset } = params;
    if (!asset.storageKey) return { status: 'skipped', reason: 'no_file', mediaId: asset.id };

    const { buffer, mimeType: storedMime } = await readMediaGalleryFile(asset.storageKey);
    const mimeType = asset.mimeType || storedMime;
    const waKind = resolveOutboundWhatsAppKind(mimeType);
    const sendKind =
      asset.type === 'pdf' || asset.type === 'document'
        ? 'document'
        : waKind === 'image' || waKind === 'video'
          ? waKind
          : 'document';

    const caption = asset.title;
    let waMediaId: string | undefined;
    let sent;
    try {
      waMediaId = await uploadWhatsAppMedia(
        params.accessToken,
        params.phoneNumberId,
        buffer,
        mimeType,
        asset.filename
      );
      sent = await sendWhatsAppMediaMessage(
        params.accessToken,
        params.phoneNumberId,
        params.contactPhone,
        sendKind,
        waMediaId,
        caption,
        asset.filename
      );
    } catch (uploadErr) {
      // Fallback: public URL (same file Meta can fetch) when upload/FormData fails.
      if (!asset.url?.startsWith('https://')) throw uploadErr;
      const linkKind =
        sendKind === 'image' || sendKind === 'video' ? sendKind : 'document';
      sent = await sendWhatsAppMediaByLink(
        params.accessToken,
        params.phoneNumberId,
        params.contactPhone,
        linkKind,
        asset.url,
        caption,
        asset.filename
      );
    }

    const preview = previewForMessage(sendKind, '[media]', caption);
    const message = await prisma.message.create({
      data: {
        waMessageId: sent.waMessageId,
        conversationId: params.conversationId,
        sender: 'agent',
        senderName: params.agentName,
        content: preview,
        type: sendKind,
        status: 'sent',
        metadata: {
          source: 'ai_agent',
          agentId: params.agentId,
          mediaAssetId: asset.id,
          mimeType,
          fileName: asset.filename,
          caption,
          storageKey: asset.storageKey,
          waMediaId: waMediaId ?? null,
          mediaLink: waMediaId ? undefined : asset.url,
          mediaType: asset.type || mediaTypeFromMime(mimeType, asset.filename),
        },
      },
    });

    await prisma.conversation.updateMany({
      where: { id: params.conversationId, workspaceId: params.workspaceId },
      data: {
        lastMessage: preview.slice(0, 200),
        lastMessageAt: new Date(),
      },
    });

    getIo().to(params.workspaceId).emit('new_message', {
      conversationId: params.conversationId,
      message,
    });
    getIo().to(params.workspaceId).emit('conversation_updated', {
      conversationId: params.conversationId,
    });

    await clearPendingMediaOffer(params.workspaceId, params.conversationId);
    return { status: 'sent', mediaId: asset.id, waMessageId: sent.waMessageId };
  } catch (err) {
    return {
      status: 'skipped',
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Plan + optionally send. Prefer `planAgentMediaAttachment` when the offer line
 * must be merged into the text reply before WhatsApp send.
 */
export async function maybeSendAgentMedia(params: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  contactPhone: string;
  query: string;
  intent: string;
  accessToken: string;
  phoneNumberId: string;
  audience?: 'customer' | 'partner';
  mediaId?: string;
}): Promise<SendMediaResult> {
  const plan = await planAgentMediaAttachment(params);
  if (plan.kind === 'skip') {
    return {
      status: 'skipped',
      reason: plan.reason,
      mediaId: plan.mediaId,
      detail: plan.detail,
    };
  }
  if (plan.kind === 'offer') {
    return { status: 'offered', mediaId: plan.asset.id, offerLine: plan.offerLine };
  }
  return sendAgentMediaAsset({ ...params, asset: plan.asset });
}
