import axios from 'axios';
import { io, prisma } from '../index.js';
import { formatInstagramContactPhone } from '../lib/channelContact.js';
import { decryptSecret } from '../lib/field-encryption.js';
import { resolveInstagramContactName } from '../lib/instagramProfile.js';
import { refreshInstagramContactProfile } from './instagramContactProfile.js';
import { emitInstagramSyncProgress } from './instagramSyncNotify.js';
import { findOrReopenConversationForInbound } from './conversationThread.service.js';
import { subscribeInstagramPageWebhooks } from './instagramWebhookSubscribe.js';
import {
  downloadInstagramMediaUrl,
  parseGraphInstagramMessage,
  saveMessageMediaFile,
  type MessageMediaMetadata,
} from './instagramMedia.js';
import {
  isInstagramPageSender,
  resolveInstagramThreadCustomer,
  type InstagramGraphMessage,
  type InstagramGraphParticipant,
} from './instagramSyncParticipants.js';

const GRAPH = 'https://graph.facebook.com/v25.0';
/** Temporary cap — keep list small while Meta timeouts are being shaken out. */
const DEFAULT_CONVERSATIONS_PAGE_LIMIT = 20;
/** Valid Conversation fields only — nested message fields on the conversation node break/omit participants. */
const CONVERSATION_LIST_FIELDS =
  // ponytail: omit attachments on list pages — Meta times out on deep pagination with nested media
  'id,updated_time,participants{id,username,name},messages.limit(1){id,message,from,created_time}';
const MESSAGE_ATTACHMENT_FIELDS =
  'id,mime_type,name,file_url,image_data,video_data';
const MESSAGE_LIST_FIELDS = `id,message,from,created_time,attachments{${MESSAGE_ATTACHMENT_FIELDS}}`;
const CONVERSATION_DETAIL_FIELDS = `id,updated_time,participants{id,username,name},messages.limit(5){${MESSAGE_LIST_FIELDS}}`;
/** Temporary: 1 page × 20 = max 20 threads until sync is stable. */
const DEFAULT_MAX_CONVERSATION_PAGES = 1;
/** List pagination with nested fields is slow on Meta — 20s was aborting mid-sync. */
const GRAPH_HTTP_TIMEOUT_MS = 60_000;
const GRAPH_GET_RETRIES = 2;

export { DEFAULT_MAX_CONVERSATION_PAGES };
export {
  isInstagramPageSender,
  pickCustomerFromMessages,
  pickCustomerParticipant,
  resolveInstagramThreadCustomer,
} from './instagramSyncParticipants.js';

export type InstagramSyncOptions = {
  maxPages?: number;
  conversationsPerPage?: number;
  workspaceId?: string;
  /** Meta Graph `after` cursor — used for Load more. */
  after?: string | null;
  /** Continue from saved cursor instead of restarting at the newest page. */
  loadMore?: boolean;
};

export type InstagramSyncResult = {
  syncedConversations: number;
  importedMessages: number;
  accounts: number;
  pagesFetched: number;
  loadedConversations: number;
  hasMore: boolean;
  warning?: string;
};

type GraphParticipant = InstagramGraphParticipant;

type GraphMessageAttachment = {
  mime_type?: string;
  name?: string;
  file_url?: string;
  image_data?: { url?: string };
  video_data?: { url?: string };
};

type GraphMessage = InstagramGraphMessage & {
  created_time?: string;
  attachments?: { data?: GraphMessageAttachment[] };
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

type GraphList<T> = {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string; before?: string } };
};

type InstagramAccountRow = {
  workspaceId: string;
  pageId: string;
  instagramUserId: string;
  pageAccessToken: string;
};

type SyncCounters = {
  loadedConversations: number;
  syncedConversations: number;
  skippedConversations: number;
  importedMessages: number;
};

function syncAfterKey(workspaceId: string, pageId: string) {
  return `ig:sync:after:${workspaceId}:${pageId}`;
}

async function readSyncAfter(workspaceId: string, pageId: string): Promise<string | null> {
  try {
    const { getRedis } = await import('../lib/redis.js');
    const raw = await getRedis().get(syncAfterKey(workspaceId, pageId));
    return raw?.trim() || null;
  } catch {
    return null;
  }
}

async function writeSyncAfter(
  workspaceId: string,
  pageId: string,
  after: string | null
): Promise<void> {
  try {
    const { getRedis } = await import('../lib/redis.js');
    const key = syncAfterKey(workspaceId, pageId);
    if (!after) {
      await getRedis().del(key);
      return;
    }
    // ponytail: 30d — long enough for "Load more later"; reconnect clears via fresh sync
    await getRedis().set(key, after, 'EX', 60 * 60 * 24 * 30);
  } catch {
    // cursor optional — Load more just won't resume until next successful page
  }
}

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
    skippedConversations: counters.skippedConversations,
    importedMessages: counters.importedMessages,
    ...extra,
  };
}

function isTransientGraphError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (
    err.code === 'ECONNABORTED' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ECONNRESET' ||
    err.code === 'ENOTFOUND'
  ) {
    return true;
  }
  const status = err.response?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function graphGet<T>(
  url: string,
  config?: { params?: Record<string, string>; timeout?: number }
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= GRAPH_GET_RETRIES; attempt++) {
    try {
      const res = await axios.get<T>(url, {
        ...config,
        timeout: config?.timeout ?? GRAPH_HTTP_TIMEOUT_MS,
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      if (attempt < GRAPH_GET_RETRIES && isTransientGraphError(err)) {
        // ponytail: linear backoff 1s/2s — enough for Meta blips, not a full circuit breaker
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function fetchInstagramConversations(
  pageId: string,
  pageAccessToken: string,
  options: InstagramSyncOptions,
  counters: SyncCounters
): Promise<{
  conversations: GraphConversation[];
  pagesFetched: number;
  hasMore: boolean;
  nextAfter: string | null;
}> {
  const workspaceId = options.workspaceId;
  const conversations: GraphConversation[] = [];
  const pageLimit = options.conversationsPerPage ?? DEFAULT_CONVERSATIONS_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_CONVERSATION_PAGES;
  const baseParams: Record<string, string> = {
    platform: 'instagram',
    fields: CONVERSATION_LIST_FIELDS,
    limit: String(pageLimit),
    access_token: pageAccessToken,
  };
  if (options.after) {
    baseParams.after = options.after;
  }

  let followUpUrl: string | null = null;
  let fetchFirstPage = true;
  let pagesFetched = 0;
  let hasMore = false;
  let nextAfter: string | null = null;

  while ((fetchFirstPage || followUpUrl) && pagesFetched < maxPages) {
    fetchFirstPage = false;
    pagesFetched += 1;
    let page: GraphList<GraphConversation>;

    try {
      if (followUpUrl) {
        page = await graphGet<GraphList<GraphConversation>>(followUpUrl);
      } else {
        page = await graphGet<GraphList<GraphConversation>>(`${GRAPH}/${pageId}/conversations`, {
          params: baseParams,
        });
      }
    } catch (err) {
      // Mid-pagination timeout: keep what we have rather than failing the whole sync.
      if (conversations.length > 0 && isTransientGraphError(err)) {
        console.warn('[instagram-sync] conversation list page failed — returning partial', {
          pageId,
          pagesFetched,
          loaded: conversations.length,
          err: err instanceof Error ? err.message : err,
        });
        hasMore = true;
        break;
      }
      throw err;
    }

    const batch = page.data || [];
    conversations.push(...batch);
    counters.loadedConversations += batch.length;
    nextAfter = page.paging?.cursors?.after?.trim() || nextAfter;
    hasMore = Boolean(page.paging?.next);

    if (workspaceId) {
      emitInstagramSyncProgress(workspaceId, {
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
  if (!hasMore) {
    nextAfter = null;
  }

  return { conversations, pagesFetched, hasMore, nextAfter };
}

async function fetchConversationMessages(
  conversationId: string,
  pageAccessToken: string,
  workspaceId: string | undefined,
  counters: SyncCounters
): Promise<GraphMessage[]> {
  const messages: GraphMessage[] = [];
  const baseParams = {
    fields: MESSAGE_LIST_FIELDS,
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
      page = await graphGet<GraphList<GraphMessage>>(followUpUrl);
    } else {
      page = await graphGet<GraphList<GraphMessage>>(`${GRAPH}/${conversationId}/messages`, {
        params: baseParams,
      });
    }

    messages.push(...(page.data || []));

    if (workspaceId) {
      emitInstagramSyncProgress(workspaceId, {
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

function graphErrorSubcode(err: unknown): number | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const sub = (err.response?.data as { error?: { error_subcode?: number } })?.error?.error_subcode;
  return typeof sub === 'number' ? sub : undefined;
}

function isPageSender(fromId: string | undefined, account: InstagramAccountRow): boolean {
  return isInstagramPageSender(fromId, account.pageId, account.instagramUserId);
}

function messagesFromConversation(thread: GraphConversation): GraphMessage[] {
  if (thread.messages?.data?.length) {
    return thread.messages.data;
  }
  return [];
}

async function fetchGraphConversation(
  conversationId: string,
  pageAccessToken: string
): Promise<GraphConversation | null> {
  try {
    return await graphGet<GraphConversation>(`${GRAPH}/${conversationId}`, {
      params: {
        fields: CONVERSATION_DETAIL_FIELDS,
        access_token: pageAccessToken,
      },
    });
  } catch {
    return null;
  }
}

function resolveThreadCustomer(
  participants: GraphParticipant[],
  messages: GraphMessage[],
  account: InstagramAccountRow
): GraphParticipant | undefined {
  return resolveInstagramThreadCustomer(
    participants,
    messages,
    account.pageId,
    account.instagramUserId
  );
}

async function upsertSyncedThread(
  account: InstagramAccountRow,
  thread: GraphConversation,
  messageItems: GraphMessage[]
): Promise<{ imported: number; conversationId: string } | null> {
  let resolvedThread = thread;
  let participants = parseParticipants(thread.participants);
  let customer = resolveThreadCustomer(participants, messageItems, account);

  if (!customer?.id && thread.id) {
    const detailed = await fetchGraphConversation(thread.id, account.pageAccessToken);
    if (detailed) {
      resolvedThread = { ...thread, ...detailed };
      participants = parseParticipants(detailed.participants);
      if (!messageItems.length) {
        messageItems = messagesFromConversation(detailed);
      }
      customer = resolveThreadCustomer(participants, messageItems, account);
    }
  }

  // Participants empty but messages not yet loaded — fetch once to recover the customer IGSID.
  if (!customer?.id && thread.id && messageItems.length === 0) {
    try {
      messageItems = await fetchConversationMessages(
        thread.id,
        account.pageAccessToken,
        undefined,
        {
          loadedConversations: 0,
          syncedConversations: 0,
          skippedConversations: 0,
          importedMessages: 0,
        }
      );
      customer = resolveThreadCustomer(participants, messageItems, account);
    } catch {
      // leave customer unset — caller counts skip
    }
  }

  if (!customer?.id) {
    console.warn('[instagram-sync] skip thread: no customer participant', {
      conversationId: thread.id,
      participantIds: participants.map((p) => p.id).filter(Boolean),
      messageFromIds: messageItems.map((m) => m.from?.id).filter(Boolean),
    });
    return null;
  }

  const senderId = customer.id;
  const contactPhone = formatInstagramContactPhone(senderId);

  let contact = await prisma.contact.findFirst({
    where: { phone: contactPhone, workspaceId: account.workspaceId },
  });

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name:
          customer.name ||
          (customer.username ? `@${customer.username}` : `Instagram ${senderId.slice(-6)}`),
        phone: contactPhone,
        workspaceId: account.workspaceId,
        source: 'Instagram',
      },
    });
  }

  const profile = await refreshInstagramContactProfile({
    contact,
    senderId,
    pageAccessToken: account.pageAccessToken,
    businessInstagramUserId: account.instagramUserId,
    fallbackName: customer.name,
  });

  contact =
    (await prisma.contact.findFirst({ where: { id: contact.id } })) ?? contact;

  const contactName = profile
    ? resolveInstagramContactName(profile, senderId, customer.name)
    : contact.name;

  const { conversation: conv } = await findOrReopenConversationForInbound({
    workspaceId: account.workspaceId,
    contactId: contact.id,
    channel: 'instagram',
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
          select: { id: true, waMessageId: true, content: true, type: true, metadata: true },
        })
      : [];
  const existingByWa = new Map(
    existingRows
      .filter((row) => row.waMessageId)
      .map((row) => [row.waMessageId as string, row] as const)
  );

  type PendingMedia = {
    waMessageId: string;
    messageId?: string;
    url: string;
    mimeType?: string;
    fileName?: string;
    baseMeta?: MessageMediaMetadata;
  };

  const toCreate: Array<{
    waMessageId: string;
    conversationId: string;
    sender: string;
    senderName: string;
    content: string;
    type: string;
    metadata?: object;
    createdAt: Date;
  }> = [];
  const pendingMedia: PendingMedia[] = [];

  let lastText = conv.lastMessage || '';
  let lastAt = conv.lastMessageAt;

  for (const graphMessage of rawMessages) {
    if (!graphMessage.id) continue;

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
        mediaUrl: parsed.media.url,
      };
    }

    const existing = existingByWa.get(graphMessage.id);
    if (existing) {
      const meta = (existing.metadata || {}) as MessageMediaMetadata;
      const needsRepair =
        existing.content === '[media]' ||
        (!meta.storageKey && Boolean(parsed.media?.url));
      if (needsRepair) {
        await prisma.message.update({
          where: { id: existing.id },
          data: {
            content: parsed.content,
            type: parsed.kind,
            metadata: metadata
              ? ({ ...meta, ...metadata } as object)
              : existing.metadata ?? undefined,
          },
        });
        if (parsed.media?.url && !meta.storageKey) {
          pendingMedia.push({
            waMessageId: graphMessage.id,
            messageId: existing.id,
            url: parsed.media.url,
            mimeType: parsed.media.mimeType,
            fileName: parsed.media.fileName,
            baseMeta: { ...meta, ...metadata },
          });
        }
        lastText = parsed.content;
        lastAt = createdAt;
      }
      continue;
    }

    toCreate.push({
      waMessageId: graphMessage.id,
      conversationId: conv.id,
      sender: fromPage ? 'agent' : 'contact',
      senderName: graphMessage.from?.name || (fromPage ? 'Agent' : contactName),
      content: parsed.content,
      type: parsed.kind,
      metadata: metadata ? (metadata as object) : undefined,
      createdAt,
    });

    if (parsed.media?.url) {
      pendingMedia.push({
        waMessageId: graphMessage.id,
        url: parsed.media.url,
        mimeType: parsed.media.mimeType,
        fileName: parsed.media.fileName,
        baseMeta: metadata,
      });
    }

    lastText = parsed.content;
    lastAt = createdAt;
  }

  if (toCreate.length > 0) {
    await prisma.message.createMany({ data: toCreate });

    // Sync path never hit the webhook — resume Ask Question waits for new contact replies.
    const contactReplies = toCreate.filter((m) => m.sender === 'contact' && m.content?.trim());
    if (contactReplies.length > 0) {
      try {
        const { getInstagramJourneyContainer } = await import(
          '../modules/instagram-journey/container.js'
        );
        const trigger = getInstagramJourneyContainer(prisma).triggerService;
        for (const reply of contactReplies) {
          await trigger.resumeWaitingRepliesOnly({
            workspaceId: account.workspaceId,
            event: 'dm.received',
            contactId: contact.id,
            text: reply.content,
            payload: {
              conversationId: conv.id,
              messageId: reply.waMessageId,
              source: 'instagram_sync',
            },
          });
        }
      } catch (err) {
        console.warn('[instagram-sync] journey resume failed', {
          conversationId: conv.id,
          err: err instanceof Error ? err.message : err,
        });
      }
    }
  }

  if (pendingMedia.length > 0) {
    const needLookup = pendingMedia.filter((m) => !m.messageId).map((m) => m.waMessageId);
    const createdRows =
      needLookup.length > 0
        ? await prisma.message.findMany({
            where: {
              conversationId: conv.id,
              waMessageId: { in: needLookup },
            },
            select: { id: true, waMessageId: true },
          })
        : [];
    const idByWa = new Map(createdRows.map((r) => [r.waMessageId, r.id] as const));

    for (const media of pendingMedia) {
      const messageId = media.messageId || idByWa.get(media.waMessageId);
      if (!messageId) continue;
      try {
        const downloaded = await downloadInstagramMediaUrl(media.url, account.pageAccessToken);
        const storageKey = await saveMessageMediaFile(
          account.workspaceId,
          messageId,
          downloaded.buffer,
          downloaded.mimeType || media.mimeType || 'application/octet-stream',
          media.fileName
        );
        await prisma.message.update({
          where: { id: messageId },
          data: {
            metadata: {
              ...(media.baseMeta ?? {}),
              mimeType: downloaded.mimeType || media.mimeType,
              fileName: media.fileName,
              storageKey,
            } as object,
          },
        });
      } catch (err) {
        console.warn('[instagram-sync] media download failed', {
          waMessageId: media.waMessageId,
          err: err instanceof Error ? err.message : err,
        });
      }
    }
  }

  const imported = toCreate.length;

  const threadUpdated = resolvedThread.updated_time ? new Date(resolvedThread.updated_time) : null;
  if (threadUpdated && (!lastAt || threadUpdated > lastAt)) {
    lastAt = threadUpdated;
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      lastMessage: lastText || conv.lastMessage || 'Instagram conversation',
      lastMessageAt: lastAt || threadUpdated || conv.lastMessageAt || new Date(),
      channelAccountId: account.pageId,
    },
  });

  return { imported, conversationId: conv.id };
}

async function syncPageConversations(
  account: InstagramAccountRow,
  options: InstagramSyncOptions,
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

  let after = options.after ?? null;
  if (options.loadMore && workspaceId) {
    after = (await readSyncAfter(workspaceId, account.pageId)) || after;
    if (!after) {
      return {
        pagesFetched: 0,
        hasMore: false,
        warning: 'No more Instagram chats to load. Tap Sync to refresh from the start.',
      };
    }
  } else if (workspaceId && !options.loadMore) {
    await writeSyncAfter(workspaceId, account.pageId, null);
  }

  const listOptions: InstagramSyncOptions = { ...options, after };

  try {
    const listed = await fetchInstagramConversations(
      account.pageId,
      account.pageAccessToken,
      listOptions,
      counters
    );

    if (workspaceId) {
      await writeSyncAfter(workspaceId, account.pageId, listed.nextAfter);
    }

    // Dedupe by conversation id — Meta paging can re-emit the same thread.
    const byId = new Map<string, GraphConversation>();
    for (const row of listed.conversations) {
      if (row.id) byId.set(row.id, row);
      else byId.set(`anon:${byId.size}`, row);
    }

    // Fresh sync only: some Meta setups also list on the IG user node.
    // Skip on Load more — keeps a single page cursor.
    if (
      !options.loadMore &&
      account.instagramUserId &&
      account.instagramUserId !== account.pageId
    ) {
      try {
        const shadow: SyncCounters = {
          loadedConversations: 0,
          syncedConversations: 0,
          skippedConversations: 0,
          importedMessages: 0,
        };
        const alt = await fetchInstagramConversations(
          account.instagramUserId,
          account.pageAccessToken,
          { ...listOptions, after: undefined },
          shadow
        );
        for (const row of alt.conversations) {
          if (!row.id || byId.has(row.id)) continue;
          byId.set(row.id, row);
          counters.loadedConversations += 1;
        }
        pagesFetched = Math.max(listed.pagesFetched, alt.pagesFetched);
        hasMore = listed.hasMore || alt.hasMore;
      } catch {
        // ponytail: IG-node list optional — page list is the primary Meta path
        pagesFetched = listed.pagesFetched;
        hasMore = listed.hasMore;
      }
    } else {
      pagesFetched = listed.pagesFetched;
      hasMore = listed.hasMore;
    }

    if (byId.size < listed.conversations.length) {
      counters.loadedConversations -= listed.conversations.length - byId.size;
    }
    threads = Array.from(byId.values());
  } catch (err) {
    const sub = graphErrorSubcode(err);
    if (sub === 2207085) {
      warning =
        'Meta blocked loading old Instagram chats (error 2207085). New DMs still arrive via webhook.';
      return { pagesFetched: 0, hasMore: false, warning };
    }
    throw err;
  }

  for (const thread of threads) {
    try {
      // List preview omits attachments (timeout-safe) — always pull message pages so media URLs exist.
      let msgItems: GraphMessage[] = [];
      if (thread.id) {
        try {
          msgItems = await fetchConversationMessages(
            thread.id,
            account.pageAccessToken,
            workspaceId,
            counters
          );
        } catch (msgErr) {
          // ponytail: one dead message page must not abort the whole inbox sync
          console.warn('[instagram-sync] message fetch failed', {
            conversationId: thread.id,
            err: msgErr instanceof Error ? msgErr.message : msgErr,
          });
          msgItems = messagesFromConversation(thread);
        }
      } else {
        msgItems = messagesFromConversation(thread);
      }

      const saved = await upsertSyncedThread(account, thread, msgItems);
      if (!saved) {
        counters.skippedConversations += 1;
        continue;
      }

      counters.syncedConversations += 1;
      counters.importedMessages += saved.imported;

      if (workspaceId) {
        emitInstagramSyncProgress(workspaceId, {
          phase: 'thread_saved',
          ...progressSnapshot(counters, {
            message: `Saved chat ${counters.syncedConversations}/${counters.loadedConversations} (${counters.importedMessages} messages)`,
          }),
        });

        io?.to(workspaceId).emit('conversation_updated', { conversationId: saved.conversationId });
      }
    } catch (threadErr) {
      counters.skippedConversations += 1;
      console.warn('[instagram-sync] thread sync failed', {
        conversationId: thread.id,
        err: threadErr instanceof Error ? threadErr.message : threadErr,
      });
    }
  }

  if (!warning && counters.skippedConversations > 0) {
    warning = `Skipped ${counters.skippedConversations} chat(s) — Meta didn't return a usable customer id (Requests folder / linked accounts / empty participants).`;
  }

  return { pagesFetched, hasMore, warning };
}

export async function syncInstagramConversationsForWorkspace(
  workspaceId: string,
  options: InstagramSyncOptions = {}
): Promise<InstagramSyncResult> {
  const syncOptions = { ...options, workspaceId };
  const counters: SyncCounters = {
    loadedConversations: 0,
    syncedConversations: 0,
    skippedConversations: 0,
    importedMessages: 0,
  };

  emitInstagramSyncProgress(workspaceId, {
    phase: 'started',
    ...progressSnapshot(counters, { message: 'Instagram sync started' }),
  });

  const accounts = await prisma.instagramAccount.findMany({ where: { workspaceId } });
  if (accounts.length === 0) {
    const result = {
      syncedConversations: 0,
      importedMessages: 0,
      accounts: 0,
      pagesFetched: 0,
      loadedConversations: 0,
      hasMore: false,
      warning: 'No Instagram account connected',
    };
    emitInstagramSyncProgress(workspaceId, {
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

      void subscribeInstagramPageWebhooks(
        account.pageId,
        pageAccessToken,
        account.instagramUserId
      ).catch(() => {
        // ponytail: sync still imports history if webhook subscribe fails
      });

      const stats = await syncPageConversations(
        {
          workspaceId: account.workspaceId,
          pageId: account.pageId,
          instagramUserId: account.instagramUserId,
          pageAccessToken,
        },
        syncOptions,
        counters
      );
      pagesFetched += stats.pagesFetched;
      hasMore = hasMore || stats.hasMore;
      warning = warning || stats.warning;
    }

    const result: InstagramSyncResult = {
      syncedConversations: counters.syncedConversations,
      importedMessages: counters.importedMessages,
      accounts: accounts.length,
      pagesFetched,
      loadedConversations: counters.loadedConversations,
      hasMore,
      warning,
    };

    emitInstagramSyncProgress(workspaceId, {
      phase: 'completed',
      loadedConversations: result.loadedConversations,
      syncedConversations: result.syncedConversations,
      importedMessages: result.importedMessages,
      hasMore: result.hasMore,
      warning: result.warning,
      message: options.loadMore
        ? `Loaded more: ${result.syncedConversations} chat(s), ${result.importedMessages} message(s)`
        : `Sync complete: ${result.syncedConversations} chat(s), ${result.importedMessages} message(s)`,
    });

    return result;
  } catch (err) {
    const message =
      (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message || (err as Error)?.message || 'Instagram sync failed';

    emitInstagramSyncProgress(workspaceId, {
      phase: 'error',
      ...progressSnapshot(counters, { message }),
    });
    throw err;
  }
}
