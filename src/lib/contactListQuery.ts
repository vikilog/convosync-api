import type { Prisma } from '@prisma/client';
import {
  contactChannelWhere,
  isContactChannelFilter,
} from './channelContact.js';

export const UNSUBSCRIBED_TAGS = ['Unsubscribed', 'Unsubscribe'] as const;
export const BLOCKED_TAGS = ['Blocked', 'Blocklist', 'Blocklisted'] as const;

export type ContactListFilter = 'all' | 'unsubscribe' | 'blocklist';

export function normalizeListFilter(list: unknown): ContactListFilter {
  const raw = Array.isArray(list) ? list[0] : list;
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (value === 'unsubscribe' || value === 'unsubscribed') return 'unsubscribe';
  if (value === 'blocklist' || value === 'blocked' || value === 'blocklisted') return 'blocklist';
  return 'all';
}

export function listTagWhere(list: ContactListFilter): Prisma.ContactWhereInput | undefined {
  if (list === 'unsubscribe') return { tags: { hasSome: [...UNSUBSCRIBED_TAGS] } };
  if (list === 'blocklist') return { tags: { hasSome: [...BLOCKED_TAGS] } };
  return undefined;
}

export function andWhere(
  parts: Array<Prisma.ContactWhereInput | undefined | false>
): Prisma.ContactWhereInput {
  const clauses: Prisma.ContactWhereInput[] = []
  for (const part of parts) {
    if (!part || Object.keys(part).length === 0) continue
    clauses.push(part)
  }
  if (clauses.length === 0) return {}
  if (clauses.length === 1) return clauses[0]
  return { AND: clauses }
}

export function channelListWhere(channel: unknown): Prisma.ContactWhereInput | undefined {
  if (typeof channel !== 'string' || !isContactChannelFilter(channel)) return undefined
  return contactChannelWhere(channel)
}
