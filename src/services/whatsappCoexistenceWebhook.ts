import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { resolveWorkspaceByPhoneNumberId } from './workspaceResolve.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import {
  fetchAndStoreInboundMedia,
  parseInboundWhatsAppMessage,
  previewForMessage,
} from './whatsappMedia.js';
import { upsertWhatsAppContact } from '../lib/whatsappContact.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';

type SmbMessageEcho = Record<string, unknown> & {
  id: string;
  to: string;
  from?: string;
  timestamp?: string;
};

type CoexistenceWebhookValue = {
  metadata?: { phone_number_id?: string };
  message_echoes?: SmbMessageEcho[];
  state_sync?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
  errors?: Array<{ code?: number; message?: string }>;
};

function logCoexistence(label: string, payload: unknown) {
  const line = `[WhatsApp Coexistence] ${label}`;
  console.log(line, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

export async function handleSmbMessageEchoes(value: CoexistenceWebhookValue): Promise<void> {
  const echo = value.message_echoes?.[0];
  if (!echo) return;

  const waNumberId = value.metadata?.phone_number_id;
  if (!waNumberId) {
    logCoexistence('smb_message_echoes → skip (no phone_number_id)', value.metadata);
    return;
  }

  const workspace = await resolveWorkspaceByPhoneNumberId(waNumberId);
  if (!workspace) {
    logCoexistence('smb_message_echoes → skip (unknown workspace)', { waNumberId });
    return;
  }

  const customerPhone = echo.to;
  const parsed = parseInboundWhatsAppMessage({
    id: echo.id,
    from: echo.from || customerPhone,
    type: echo.type as string | undefined,
    text: echo.text as { body?: string } | undefined,
    image: echo.image as { id?: string; link?: string; mime_type?: string; caption?: string } | undefined,
    video: echo.video as { id?: string; link?: string; mime_type?: string; caption?: string } | undefined,
    audio: echo.audio as { id?: string; link?: string; mime_type?: string } | undefined,
    document: echo.document as
      | { id?: string; link?: string; mime_type?: string; filename?: string; caption?: string }
      | undefined,
    sticker: echo.sticker as { id?: string; link?: string; mime_type?: string } | undefined,
    location: echo.location as
      | { latitude?: number; longitude?: number; name?: string; address?: string }
      | undefined,
    interactive: echo.interactive as
      | { type?: string; button_reply?: { id?: string; title?: string } }
      | undefined,
  });
  const text = parsed.content;

  const contact = await upsertWhatsAppContact({
    db: prisma,
    workspaceId: workspace.id,
    waFrom: customerPhone,
  });

  const { conversation: conv } = await findOrReopenConversationForInbound({
    workspaceId: workspace.id,
    contactId: contact.id,
    channel: 'whatsapp',
    channelAccountId: waNumberId,
  });

  const existingMessage = await prisma.message.findFirst({
    where: { waMessageId: echo.id },
  });
  if (existingMessage) {
    logCoexistence('smb_message_echoes → duplicate skipped', { waMessageId: echo.id });
    return;
  }

  let metadata: Record<string, unknown> | undefined = { source: 'smb_message_echo' };
  if (parsed.location) {
    metadata = { ...parsed.location, source: 'smb_message_echo' };
  } else if (parsed.media) {
    metadata = {
      mimeType: parsed.media.mimeType,
      fileName: parsed.media.fileName,
      caption: parsed.media.caption,
      waMediaId: parsed.media.waMediaId,
      mediaUrl: parsed.media.mediaUrl,
      source: 'smb_message_echo',
    };
  }

  const message = await prisma.message.create({
    data: {
      waMessageId: echo.id,
      conversationId: conv.id,
      sender: 'agent',
      senderName: 'WhatsApp Business App',
      content: text,
      type: parsed.kind,
      metadata: metadata as object,
    },
  });

  if (parsed.media?.waMediaId || parsed.media?.mediaUrl) {
    try {
      const credentials = await getWorkspaceWhatsAppCredentials(workspace.id, waNumberId);
      const stored = await fetchAndStoreInboundMedia({
        workspaceId: workspace.id,
        messageId: message.id,
        waToken: credentials.accessToken,
        media: parsed.media,
      });
      metadata = { ...stored, source: 'smb_message_echo' };
      await prisma.message.update({
        where: { id: message.id },
        data: { metadata: metadata as object },
      });
      message.metadata = metadata as object;
    } catch (mediaErr) {
      logCoexistence(
        'smb_message_echoes → media download failed',
        mediaErr instanceof Error ? mediaErr.message : mediaErr
      );
    }
  }

  const lastPreview = previewForMessage(parsed.kind, text, parsed.media?.caption);

  await prisma.conversation.updateMany({
    where: { id: conv.id, workspaceId: workspace.id },
    data: {
      lastMessage: lastPreview,
      lastMessageAt: new Date(),
    },
  });

  getIo().to(workspace.id).emit('new_message', { conversationId: conv.id, message });
  getIo().to(workspace.id).emit('conversation_updated', { conversationId: conv.id });

  logCoexistence('smb_message_echoes → saved', {
    messageId: message.id,
    conversationId: conv.id,
    customerPhone,
    kind: parsed.kind,
  });
}

export async function handleSmbAppStateSync(value: CoexistenceWebhookValue): Promise<void> {
  const waNumberId = value.metadata?.phone_number_id;
  if (!waNumberId) return;

  const workspace = await resolveWorkspaceByPhoneNumberId(waNumberId);
  if (!workspace) return;

  const entries = value.state_sync || [];
  for (const entry of entries) {
    const action = entry.action as string | undefined;
    const contact = entry.contact as { phone_number?: string; full_name?: string } | undefined;
    if (!contact?.phone_number) continue;

    if (action === 'remove') continue;

    await upsertWhatsAppContact({
      db: prisma,
      workspaceId: workspace.id,
      waFrom: contact.phone_number,
      profileName: contact.full_name,
    });
  }

  logCoexistence('smb_app_state_sync → processed', { count: entries.length, waNumberId });
}

export async function handleCoexistenceHistoryWebhook(value: CoexistenceWebhookValue): Promise<void> {
  if (value.errors?.length) {
    logCoexistence('history → business declined or error', value.errors);
    return;
  }

  const chunks = value.history || [];
  logCoexistence('history → received chunk', { chunks: chunks.length });
}
