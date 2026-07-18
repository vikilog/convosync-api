import axios from 'axios';
import { io, prisma } from '../index.js';
import { formatMessengerContactPhone } from '../lib/channelContact.js';
import { decryptSecret } from '../lib/field-encryption.js';
import {
  fetchMessengerUserProfile,
  resolveMessengerContactName,
} from './messenger.js';
import { emitMessengerSyncProgress } from './messengerSyncNotify.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import {
  downloadInstagramMediaUrl,
  parseGraphInstagramMessage,
  saveMessageMediaFile,
  type MessageMediaMetadata,
} from './instagramMedia.js';

const GRAPH = 'https://graph.facebook.com/v25.0';
const DEFAULT_CONVERSATIONS_PAGE_LIMIT = 1;
const CONVERSATION_LIST_FIELDS = 'participants,updated_time,id,message,from,created_time';
const DEFAULT_MAX_CONVERSATION_PAGES = 25;
const GRAPH_HTTP_TIMEOUT_MS = 20_000;

export { DEFAULT_MAX_CONVERSATION_PAGES };

export type MessengerSyncOptions = {
  maxPages?: number;
  conversationsPerPage?: number;
  workspaceId?: string;
};

export type MessengerSyncResult = {
  syncedConversations: number;
  importedMessages: number;
  accounts: number;
  pagesFetched: number;
  loadedConversations: number;
  hasMore: boolean;
  warning?: string;
};

type GraphParticipant = { id?: string; name?: string; username?: string };

type GraphMessage = {
  id?: string;
  message?: string;
  from?: GraphParticipant;
  created_time?: string;
  attachments?: { data?: GraphMessageAttachment[] };
};

type GraphMessageAttachment = {
  mime_type?: string;
  name?: string;
  file_url?: string;
  image_data?: { url?: string };
  video_data?: { url?: string };
};

type GraphConversation = {
  id?: string;
  updated_time?: string;
  participants?: { data?: GraphParticipant[] } | GraphParticipant[];
  messages?: { data?: GraphMessage[] };
  message?: string;
  from?: GraphParticipant;
  created_time?: string;
};

type GraphList<T> = { data?: T[]; paging?: { next?: string } };

type MessengerAccountRow = {
  workspaceId: string;
  pageId: string;
  pageAccessToken: string;
};

type SyncCounters = {
  loadedConversations: number;
  syncedConversations: number;
  importedMessages: number;
};

function parseParticipants(
  raw: GraphConversation['participants'] | undefined
): GraphParticipant[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((p) => p?.id);
  if (Array.isArray(raw.data)) return raw.data.filter((p) => p?.id);
  return [];
}

function progressSnapshot(counters: SyncCounters, extra?: { pageNumber?: number; message?: string }) {
  return {
    loadedConversations: counters.loadedConversations,
    syncedConversations: counters.syncedConversations,
    importedMessages: counters.importedMessages,
    ...extra,
  };
}

async function fetchMessengerConversations(
  pageId: string,
  pageAccessToken: string,
  options: MessengerSyncOptions,
  counters: SyncCounters
): Promise<{ conversations: GraphConversation[]; pagesFetched: number; hasMore: boolean }> {
  const workspaceId = options.workspaceId;
  const conversations: GraphConversation[] = [];
  const pageLimit = options.conversationsPerPage ?? DEFAULT_CONVERSATIONS_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_CONVERSATION_PAGES;
  const baseParams = {
    fields: CONVERSATION_LIST_FIELDS,
    limit: String(pageLimit),
    access_token: pageAccessToken,
  };

  let followUpUrl: string | null = null;
  let fetchFirstPage = true;
  let pagesFetched = 0;
  let hasMore = false;

  while ((fetchFirstPage || followUpUrl) && pagesFetched < maxPages) {
    fetchFirstPage = false;
    pagesFetched += 1;
    let page: GraphList<GraphConversation>;

    if (followUpUrl) {
      const res = await axios.get<GraphList<GraphConversation>>(followUpUrl, {
        timeout: GRAPH_HTTP_TIMEOUT_MS,
      });
      page = res.data;
    } else {
      const res = await axios.get<GraphList<GraphConversation>>(
        `${GRAPH}/${pageId}/conversations`,
        { params: baseParams, timeout: GRAPH_HTTP_TIMEOUT_MS }
      );
      page = res.data;
    }

    const batch = page.data || [];
    conversations.push(...batch);
    counters.loadedConversations += batch.length;

    if (workspaceId) {
      emitMessengerSyncProgress(workspaceId, {
        phase: 'list_page',
        ...progressSnapshot(counters, {
          pageNumber: pagesFetched,
          message: `Meta page ${pagesFetched}: loaded ${counters.loadedConversations} conversation(s) so far`,
        }),
      });
    }

    followUpUrl = page.paging?.next || null;
  }

  if (followUpUrl) {
    hasMore = true;
  }

  return { conversations, pagesFetched, hasMore };
}

async function fetchConversationMessages(
  conversationId: string,
  pageAccessToken: string,
  workspaceId: string | undefined,
  counters: SyncCounters
): Promise<GraphMessage[]> {
  const messages: GraphMessage[] = [];
  const baseParams = {
    fields: 'id,message,from,created_time,attachments',
    limit: '50',
    access_token: pageAccessToken,
  };
  let followUpUrl: string | null = null;
  let fetchFirstPage = true;
  let pages = 0;
  const maxPages = 5;

  while ((fetchFirstPage || followUpUrl) && pages < maxPages) {
    fetchFirstPage = false;
    pages += 1;
    let page: GraphList<GraphMessage>;

    if (followUpUrl) {
      const res = await axios.get<GraphList<GraphMessage>>(followUpUrl, {
        timeout: GRAPH_HTTP_TIMEOUT_MS,
      });
      page = res.data;
    } else {
      const res = await axios.get<GraphList<GraphMessage>>(`${GRAPH}/${conversationId}/messages`, {
        params: baseParams,
        timeout: GRAPH_HTTP_TIMEOUT_MS,
      });
      page = res.data;
    }

    messages.push(...(page.data || []));

    if (workspaceId) {
      emitMessengerSyncProgress(workspaceId, {
        phase: 'messages_fetch',
        ...progressSnapshot(counters, {
          message: `Fetched messages for chat (${messages.length} on this thread)`,
        }),
      });
    }

    followUpUrl = page.paging?.next || null;
  }

  return messages;
}

function isPageSender(fromId: string | undefined, account: MessengerAccountRow): boolean {
  if (!fromId) return false;
  return fromId === account.pageId;
}

function pickCustomerParticipant(
  participants: GraphParticipant[],
  account: MessengerAccountRow
): GraphParticipant | undefined {
  return participants.find((participant) => participant.id && participant.id !== account.pageId);
}

function messagesFromConversation(thread: GraphConversation): GraphMessage[] {
  if (thread.messages?.data?.length) {
    return thread.messages.data;
  }
  return [];
}

async function upsertSyncedThread(
  account: MessengerAccountRow,
  thread: GraphConversation,
  messageItems: GraphMessage[]
): Promise<{ imported: number; conversationId: string } | null> {
  const participants = parseParticipants(thread.participants);
  const customer = pickCustomerParticipant(participants, account);
  if (!customer?.id) return null;

  const senderId = customer.id;
  const contactPhone = formatMessengerContactPhone(senderId);

  let contact = await prisma.contact.findFirst({
    where: { phone: contactPhone, workspaceId: account.workspaceId },
  });

  const profile = await fetchMessengerUserProfile(senderId, account.pageAccessToken);
  const contactName = resolveMessengerContactName(profile, senderId);

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name: customer.name || contactName,
        phone: contactPhone,
        workspaceId: account.workspaceId,
        source: 'Messenger',
        avatar: profile.profile_pic,
      },
    });
  } else {
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        name: contact.name === contactPhone ? contactName : contact.name,
        avatar: contact.avatar || profile.profile_pic || undefined,
      },
    });
  }

  const { conversation: conv } = await findOrReopenConversationForInbound({
    workspaceId: account.workspaceId,
    contactId: contact.id,
    channel: 'messenger',
    channelAccountId: account.pageId,
  });

  const rawMessages = [...messageItems].sort((a, b) => {
    const aTime = a.created_time ? Date.parse(a.created_time) : 0;
    const bTime = b.created_time ? Date.parse(b.created_time) : 0;
    return aTime - bTime;
  });

  const graphMessageIds = rawMessages.map((m) => m.id).filter(Boolean) as string[];
  const existingRows =
    graphMessageIds.length > 0
      ? await prisma.message.findMany({
          where: { waMessageId: { in: graphMessageIds } },
          select: { waMessageId: true },
        })
      : [];
  const existingIds = new Set(existingRows.map((row) => row.waMessageId).filter(Boolean));

  let imported = 0;
  let lastText = conv.lastMessage || '';
  let lastAt = conv.lastMessageAt;

  for (const graphMessage of rawMessages) {
    if (!graphMessage.id || existingIds.has(graphMessage.id)) continue;

    const fromPage = isPageSender(graphMessage.from?.id, account);
    const parsed = parseGraphInstagramMessage(graphMessage.message, graphMessage.attachments);
    const createdAt = graphMessage.created_time
      ? new Date(graphMessage.created_time)
      : new Date();

    let metadata: MessageMediaMetadata | undefined;
    if (parsed.media) {
      metadata = {
        mimeType: parsed.media.mimeType,
        fileName: parsed.media.fileName,
      };
    }

    const created = await prisma.message.create({
      data: {
        waMessageId: graphMessage.id,
        conversationId: conv.id,
        sender: fromPage ? 'agent' : 'contact',
        senderName: graphMessage.from?.name || (fromPage ? 'Agent' : contactName),
        content: parsed.content,
        type: parsed.kind,
        metadata: metadata ? (metadata as object) : undefined,
        createdAt,
      },
    });

    if (parsed.media?.url) {
      try {
        const downloaded = await downloadInstagramMediaUrl(
          parsed.media.url,
          account.pageAccessToken
        );
        const storageKey = await saveMessageMediaFile(
          account.workspaceId,
          created.id,
          downloaded.buffer,
          downloaded.mimeType || parsed.media.mimeType || 'application/octet-stream',
          parsed.media.fileName
        );
        await prisma.message.update({
          where: { id: created.id },
          data: {
            metadata: {
              ...(metadata ?? {}),
              mimeType: downloaded.mimeType || parsed.media.mimeType,
              fileName: parsed.media.fileName,
              storageKey,
            } as object,
          },
        });
      } catch {
        // Graph attachment URLs may expire; keep preview text only
      }
    }

    imported += 1;
    lastText = parsed.content;
    lastAt = createdAt;
  }

  const threadUpdated = thread.updated_time ? new Date(thread.updated_time) : null;
  if (threadUpdated && (!lastAt || threadUpdated > lastAt)) {
    lastAt = threadUpdated;
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      lastMessage: lastText || conv.lastMessage || 'Messenger conversation',
      lastMessageAt: lastAt || threadUpdated || conv.lastMessageAt || new Date(),
      channelAccountId: account.pageId,
    },
  });

  return { imported, conversationId: conv.id };
}

async function syncPageConversations(
  account: MessengerAccountRow,
  options: MessengerSyncOptions,
  counters: SyncCounters
): Promise<{
  pagesFetched: number;
  hasMore: boolean;
  warning?: string;
}> {
  const workspaceId = options.workspaceId;
  let warning: string | undefined;
  let threads: GraphConversation[] = [];
  let pagesFetched = 0;
  let hasMore = false;

  const listed = await fetchMessengerConversations(
    account.pageId,
    account.pageAccessToken,
    options,
    counters
  );
  threads = listed.conversations;
  pagesFetched = listed.pagesFetched;
  hasMore = listed.hasMore;

  for (const thread of threads) {
    let msgItems = messagesFromConversation(thread);
    if (thread.id && msgItems.length === 0) {
      msgItems = await fetchConversationMessages(
        thread.id,
        account.pageAccessToken,
        workspaceId,
        counters
      );
    }

    const saved = await upsertSyncedThread(account, thread, msgItems);
    if (!saved) continue;

    counters.syncedConversations += 1;
    counters.importedMessages += saved.imported;

    if (workspaceId) {
      emitMessengerSyncProgress(workspaceId, {
        phase: 'thread_saved',
        ...progressSnapshot(counters, {
          message: `Saved chat ${counters.syncedConversations}/${counters.loadedConversations} (${counters.importedMessages} messages)`,
        }),
      });

      io?.to(workspaceId).emit('conversation_updated', { conversationId: saved.conversationId });
    }
  }

  return { pagesFetched, hasMore, warning };
}

export async function syncMessengerConversationsForWorkspace(
  workspaceId: string,
  options: MessengerSyncOptions = {}
): Promise<MessengerSyncResult> {
  const syncOptions = { ...options, workspaceId };
  const counters: SyncCounters = {
    loadedConversations: 0,
    syncedConversations: 0,
    importedMessages: 0,
  };

  emitMessengerSyncProgress(workspaceId, {
    phase: 'started',
    ...progressSnapshot(counters, { message: 'Messenger sync started' }),
  });

  const accounts = await prisma.messengerAccount.findMany({ where: { workspaceId } });
  if (accounts.length === 0) {
    const result = {
      syncedConversations: 0,
      importedMessages: 0,
      accounts: 0,
      pagesFetched: 0,
      loadedConversations: 0,
      hasMore: false,
      warning: 'No Messenger account connected',
    };
    emitMessengerSyncProgress(workspaceId, {
      phase: 'completed',
      loadedConversations: 0,
      syncedConversations: 0,
      importedMessages: 0,
      message: result.warning,
    });
    return result;
  }

  let pagesFetched = 0;
  let hasMore = false;
  let warning: string | undefined;

  try {
    for (const account of accounts) {
      const pageAccessToken = decryptSecret(account.pageAccessToken);
      if (!pageAccessToken) continue;

      const stats = await syncPageConversations(
        {
          workspaceId: account.workspaceId,
          pageId: account.pageId,
          pageAccessToken,
        },
        syncOptions,
        counters
      );
      pagesFetched += stats.pagesFetched;
      hasMore = hasMore || stats.hasMore;
      warning = warning || stats.warning;
    }

    const result: MessengerSyncResult = {
      syncedConversations: counters.syncedConversations,
      importedMessages: counters.importedMessages,
      accounts: accounts.length,
      pagesFetched,
      loadedConversations: counters.loadedConversations,
      hasMore,
      warning,
    };

    emitMessengerSyncProgress(workspaceId, {
      phase: 'completed',
      loadedConversations: result.loadedConversations,
      syncedConversations: result.syncedConversations,
      importedMessages: result.importedMessages,
      hasMore: result.hasMore,
      warning: result.warning,
      message: `Sync complete: ${result.syncedConversations} chat(s), ${result.importedMessages} message(s)`,
    });

    return result;
  } catch (err) {
    const message =
      (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message || (err as Error)?.message || 'Messenger sync failed';

    emitMessengerSyncProgress(workspaceId, {
      phase: 'error',
      ...progressSnapshot(counters, { message }),
    });
    throw err;
  }
}
