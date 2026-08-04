import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { decryptSecret } from '../lib/field-encryption.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import { formatInstagramContactPhone } from '../lib/channelContact.js';
import { resolveInstagramContactName } from '../lib/instagramProfile.js';
import { refreshInstagramContactProfile } from './instagramContactProfile.js';
import { findInstagramAccountByEntryId } from './workspaceResolve.js';
import { takeInstagramThreadControl } from './instagramWebhookSubscribe.js';
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
    /** Quick-reply tap — payload is what we configured; text is often the button title. */
    quick_reply?: { payload?: string };
    attachments?: Array<{
      type?: string;
      payload?: { url?: string; title?: string; sticker_id?: number };
    }>;
  };
  /** Persistent menu / postback button */
  postback?: {
    mid?: string;
    payload?: string;
    title?: string;
  };
  /** Instagram messaging_seen / Messenger message_reads */
  read?: {
    mid?: string;
    watermark?: number;
  };
};

function logInstagramWebhook(label: string, payload: unknown) {
  const line = `[Instagram Webhook] ${label}`;
  console.log(line, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

async function upsertInstagramInboundMessage(params: {
  pageId: string;
  senderId: string;
  messageId: string;
  parsed: ParsedInboundInstagram;
  pageAccessToken: string;
  fromStandby?: boolean;
}) {
  const account = await findInstagramAccountByEntryId(params.pageId);
  if (!account?.workspace) {
    logInstagramWebhook('skip unknown page/ig entry', { entryId: params.pageId });
    return;
  }
  const workspace = account.workspace;

  const existing = await prisma.message.findFirst({
    where: { waMessageId: params.messageId },
  });
  if (existing) {
    logInstagramWebhook('skip duplicate message', { messageId: params.messageId });
    // Sync often wins the race and saves first — still resume waiting Ask Question.
    try {
      const convMeta = await prisma.conversation.findFirst({
        where: { id: existing.conversationId },
        select: { contactId: true, workspaceId: true },
      });
      if (convMeta?.contactId) {
        const { getInstagramJourneyContainer } = await import(
          '../modules/instagram-journey/container.js'
        );
        await getInstagramJourneyContainer(prisma).triggerService.resumeWaitingRepliesOnly({
          workspaceId: convMeta.workspaceId,
          event: 'dm.received',
          contactId: convMeta.contactId,
          text: params.parsed.content || existing.content,
          payload: {
            conversationId: existing.conversationId,
            messageId: params.messageId,
          },
        });
      }
    } catch (igErr) {
      logInstagramWebhook(
        'instagram journey resume on duplicate failed',
        igErr instanceof Error ? igErr.message : igErr
      );
    }
    return;
  }

  const contactPhone = formatInstagramContactPhone(params.senderId);

  let contact = await prisma.contact.findFirst({
    where: { phone: contactPhone, workspaceId: workspace.id },
  });

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name: `Instagram ${params.senderId.slice(-6)}`,
        phone: contactPhone,
        workspaceId: workspace.id,
        source: 'Instagram',
      },
    });
  }

  const profile = await refreshInstagramContactProfile({
    contact,
    senderId: params.senderId,
    pageAccessToken: params.pageAccessToken,
    businessInstagramUserId: account.instagramUserId,
  });

  contact =
    (await prisma.contact.findFirst({ where: { id: contact.id } })) ?? contact;

  const contactName = profile
    ? resolveInstagramContactName(profile, params.senderId)
    : contact.name;

  const { conversation: conv } = await findOrReopenConversationForInbound({
    workspaceId: workspace.id,
    contactId: contact.id,
    channel: 'instagram',
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
      logInstagramWebhook(
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

  if (params.fromStandby) {
    try {
      await takeInstagramThreadControl(
        account.pageId,
        params.pageAccessToken,
        params.senderId
      );
      logInstagramWebhook('took thread control after standby', {
        pageId: account.pageId,
        senderId: params.senderId,
      });
    } catch (err) {
      logInstagramWebhook(
        'take_thread_control failed',
        err instanceof Error ? err.message : err
      );
    }
  }

  logInstagramWebhook('saved message', {
    messageId: message.id,
    conversationId: conv.id,
    contactId: contact.id,
    fromStandby: Boolean(params.fromStandby),
  });

  // Same assignee routing as WhatsApp (AI Agent / etc.)
  try {
    await routeInboundConversation({
      workspaceId: workspace.id,
      conversationId: conv.id,
      contactId: contact.id,
      contactPhone,
      text: params.parsed.content,
      channel: 'instagram',
    });
  } catch (routeErr) {
    logInstagramWebhook(
      'inbound route failed',
      routeErr instanceof Error ? routeErr.message : routeErr
    );
  }

  // Instagram Automation (separate from WhatsApp journeys) — event/keyword match
  try {
    const { getInstagramJourneyContainer } = await import(
      '../modules/instagram-journey/container.js'
    );
    await getInstagramJourneyContainer(prisma).triggerService.handleDmReceived({
      workspaceId: workspace.id,
      event: 'dm.received',
      contactId: contact.id,
      text: params.parsed.content,
      payload: {
        conversationId: conv.id,
        messageId: message.id,
        // Prefer Meta mid for idempotency; buttonPayload helps BUTTONS matching
        buttonPayload:
          typeof params.parsed.content === 'string' ? params.parsed.content : undefined,
      },
    });
  } catch (igErr) {
    logInstagramWebhook(
      'instagram journey trigger failed',
      igErr instanceof Error ? igErr.message : igErr
    );
  }
}

export type PageMessagingWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: PageMessagingEvent[];
    standby?: PageMessagingEvent[];
    changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
  }>;
};

function collectMessagingEvents(entry: {
  messaging?: PageMessagingEvent[];
  standby?: PageMessagingEvent[];
}): Array<{ event: PageMessagingEvent; fromStandby: boolean }> {
  const out: Array<{ event: PageMessagingEvent; fromStandby: boolean }> = [];
  for (const event of entry.messaging || []) {
    out.push({ event, fromStandby: false });
  }
  for (const event of entry.standby || []) {
    out.push({ event, fromStandby: true });
  }
  return out;
}

export async function handleInstagramWebhookBody(body: PageMessagingWebhookBody) {
  if (body.object !== 'page' && body.object !== 'instagram') {
    logInstagramWebhook('ignored object', { object: body.object });
    return;
  }

  for (const entry of body.entry || []) {
    const entryId = entry.id;
    if (!entryId) continue;

    const account = await findInstagramAccountByEntryId(entryId);
    if (!account) {
      logInstagramWebhook('skip unregistered entry', { entryId });
      continue;
    }

    const pageAccessToken = decryptSecret(account.pageAccessToken);
    if (!pageAccessToken) {
      logInstagramWebhook('skip account missing page token', { entryId });
      continue;
    }

    const ours = new Set([account.pageId, account.instagramUserId].filter(Boolean));
    const events = collectMessagingEvents(entry);

    if (events.length === 0) {
      // comments/live_comments are handled in handleInstagramCommentWebhookBody
      if ((entry.changes?.length ?? 0) > 0) continue;
      logInstagramWebhook('entry with no messaging/standby events', { entryId });
      continue;
    }

    for (const { event, fromStandby } of events) {
      if (event.message?.messaging_product === 'facebook') continue;

      const senderId = event.sender?.id;
      if (!senderId) {
        logInstagramWebhook('skip event missing sender', { entryId, fromStandby });
        continue;
      }

      // messaging_seen — customer read our outbound message(s)
      if (event.read) {
        const mid = event.read.mid;
        if (!mid) {
          logInstagramWebhook('skip read without mid', { entryId, read: event.read });
          continue;
        }
        await applyMessagingReadReceipt({
          channel: 'instagram',
          workspaceId: account.workspaceId,
          mid,
          log: logInstagramWebhook,
        });
        continue;
      }

      if (ours.has(senderId)) continue;

      // Persistent menu / postback → treat as inbound text (payload)
      if (event.postback?.payload) {
        const mid =
          event.postback.mid?.trim() ||
          `postback_${senderId}_${event.timestamp ?? Date.now()}`;
        const parsed = parseInboundInstagramMessage(event.postback.payload.trim());
        await upsertInstagramInboundMessage({
          pageId: account.pageId,
          senderId,
          messageId: mid,
          parsed,
          pageAccessToken,
          fromStandby,
        });
        continue;
      }

      const message = event.message;
      if (!message?.mid) {
        logInstagramWebhook('skip event missing message mid', {
          entryId,
          hasSender: Boolean(senderId),
          fromStandby,
          keys: Object.keys(event),
        });
        continue;
      }
      if (message.is_echo) continue;

      // Prefer quick_reply.payload so Branch can match configured payload (e.g. "custom")
      const quickPayload = message.quick_reply?.payload?.trim();
      const inboundText = quickPayload || message.text;
      const parsed = parseInboundInstagramMessage(inboundText, message.attachments);
      await upsertInstagramInboundMessage({
        pageId: account.pageId,
        senderId,
        messageId: message.mid,
        parsed,
        pageAccessToken,
        fromStandby,
      });
    }
  }
}

export { logInstagramWebhook };
