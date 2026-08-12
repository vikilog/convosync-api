import { Prisma } from '@prisma/client';
import { prisma } from '../index.js';
import type { WorkspaceMemberRole } from './workspaceMemberAdmin.js';

export type InboxChannel = 'whatsapp' | 'instagram' | 'messenger' | 'email';

export type InboxScope = {
  mode: 'all' | 'restricted';
  channels?: InboxChannel[];
  accounts?: Partial<Record<InboxChannel, string[]>>;
};

export const FULL_INBOX_SCOPE: InboxScope = { mode: 'all' };

const INBOX_CHANNELS: InboxChannel[] = ['whatsapp', 'instagram', 'messenger', 'email'];

function isInboxChannel(value: string): value is InboxChannel {
  return (INBOX_CHANNELS as string[]).includes(value);
}

export function parseInboxScope(value: unknown): InboxScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.mode !== 'all' && record.mode !== 'restricted') return null;

  const channels = Array.isArray(record.channels)
    ? record.channels.filter((c): c is InboxChannel => typeof c === 'string' && isInboxChannel(c))
    : undefined;

  const accounts: Partial<Record<InboxChannel, string[]>> = {};
  if (record.accounts && typeof record.accounts === 'object' && !Array.isArray(record.accounts)) {
    const raw = record.accounts as Record<string, unknown>;
    for (const ch of INBOX_CHANNELS) {
      const list = raw[ch];
      if (Array.isArray(list)) {
        const ids = list.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length > 0) accounts[ch] = [...new Set(ids)];
      }
    }
  }

  return {
    mode: record.mode,
    channels: channels?.length ? channels : undefined,
    accounts: Object.keys(accounts).length ? accounts : undefined,
  };
}

export function normalizeInboxScope(input: unknown): InboxScope | null {
  const parsed = parseInboxScope(input);
  if (!parsed) return null;
  if (parsed.mode === 'all') return FULL_INBOX_SCOPE;
  if (!parsed.channels?.length && !parsed.accounts) return FULL_INBOX_SCOPE;
  return parsed;
}

export function resolveEffectiveInboxScope(
  role: WorkspaceMemberRole,
  scope: unknown
): InboxScope {
  if (role === 'admin') return FULL_INBOX_SCOPE;
  return normalizeInboxScope(scope) ?? FULL_INBOX_SCOPE;
}

type ChannelAccess = Map<InboxChannel, string[] | 'all'>;

function restrictedChannelAccess(scope: InboxScope): ChannelAccess {
  const access: ChannelAccess = new Map();
  const channels = scope.channels ?? [];
  const accounts = scope.accounts ?? {};

  for (const ch of INBOX_CHANNELS) {
    const ids = accounts[ch];
    if (ids && ids.length > 0) {
      access.set(ch, ids);
    } else if (channels.includes(ch)) {
      access.set(ch, 'all');
    }
  }

  return access;
}

export function buildConversationScopeWhere(
  scope: InboxScope
): Prisma.ConversationWhereInput | undefined {
  if (scope.mode === 'all') return undefined;

  const access = restrictedChannelAccess(scope);
  if (access.size === 0) {
    return { id: '__inbox_scope_denied__' };
  }

  const or: Prisma.ConversationWhereInput[] = [];
  for (const [channel, allowed] of access) {
    if (allowed === 'all' || channel === 'email') {
      or.push({ channel });
    } else {
      or.push({ channel, channelAccountId: { in: allowed } });
    }
  }

  return { OR: or };
}

export function conversationMatchesInboxScope(
  conversation: { channel: string; channelAccountId: string | null },
  scope: InboxScope
): boolean {
  if (scope.mode === 'all') return true;

  const access = restrictedChannelAccess(scope);
  const channel = conversation.channel as InboxChannel;
  if (!isInboxChannel(channel)) return false;

  const allowed = access.get(channel);
  if (!allowed) return false;
  if (allowed === 'all' || channel === 'email') return true;
  if (!conversation.channelAccountId) return false;
  return allowed.includes(conversation.channelAccountId);
}

export function inboxScopeForStorage(
  scope: InboxScope | null
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (!scope || scope.mode === 'all') return Prisma.DbNull;
  return scope as Prisma.InputJsonValue;
}

export function inboxScopesEqual(a: InboxScope | null, b: InboxScope | null): boolean {
  return JSON.stringify(a ?? FULL_INBOX_SCOPE) === JSON.stringify(b ?? FULL_INBOX_SCOPE);
}

export async function validateInboxScopeForWorkspace(
  workspaceId: string,
  scope: unknown
): Promise<InboxScope | null> {
  const normalized = normalizeInboxScope(scope);
  if (!normalized || normalized.mode === 'all') return null;

  const accounts = { ...(normalized.accounts ?? {}) };
  const channels = [...(normalized.channels ?? [])];

  if (accounts.whatsapp?.length) {
    const rows = await prisma.whatsAppPhoneAccount.findMany({
      where: { workspaceId, phoneNumberId: { in: accounts.whatsapp } },
      select: { phoneNumberId: true },
    });
    accounts.whatsapp = rows.map((r) => r.phoneNumberId);
    if (!channels.includes('whatsapp') && accounts.whatsapp.length > 0) {
      channels.push('whatsapp');
    }
  }

  if (accounts.instagram?.length) {
    const rows = await prisma.instagramAccount.findMany({
      where: { workspaceId, pageId: { in: accounts.instagram } },
      select: { pageId: true },
    });
    accounts.instagram = rows.map((r) => r.pageId);
    if (!channels.includes('instagram') && accounts.instagram.length > 0) {
      channels.push('instagram');
    }
  }

  if (accounts.messenger?.length) {
    const rows = await prisma.messengerAccount.findMany({
      where: { workspaceId, pageId: { in: accounts.messenger } },
      select: { pageId: true },
    });
    accounts.messenger = rows.map((r) => r.pageId);
    if (!channels.includes('messenger') && accounts.messenger.length > 0) {
      channels.push('messenger');
    }
  }

  // email has no account ids — channel flag alone is enough
  if (channels.includes('email')) {
    delete accounts.email;
  }

  const hasAccounts = Object.values(accounts).some((ids) => ids && ids.length > 0);
  if (!channels.length && !hasAccounts) {
    throw new Error('Inbox access must include at least one channel or account');
  }

  return {
    mode: 'restricted',
    channels: channels.length ? channels : undefined,
    accounts: hasAccounts ? accounts : undefined,
  };
}

export function resolveInboxScopeForMember(input: {
  role: WorkspaceMemberRole;
  permissions: string[];
  inboxScope: unknown;
}): InboxScope {
  if (input.role === 'admin') return FULL_INBOX_SCOPE;
  if (!input.permissions.includes('inbox')) return FULL_INBOX_SCOPE;
  return resolveEffectiveInboxScope(input.role, input.inboxScope);
}
