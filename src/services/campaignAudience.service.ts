import type { Prisma } from '@prisma/client';
import { prisma } from '../index.js';
import { normalizeSegmentIds, segmentsWhere, type TagMatchMode } from './campaignAudienceFilter.js';

export type CampaignAudienceChannel = 'whatsapp' | 'email' | 'instagram';

export {
  audienceTagFromIds,
  normalizeSegmentIds,
  resolveAudienceCountArgs,
  resolveSegmentIdsFromFilter,
  resolveTagMatchModeFromFilter,
  segmentIdToTag,
  segmentLabelFromIds,
  segmentsWhere,
  type TagMatchMode,
} from './campaignAudienceFilter.js';

const EXCLUDED_TAGS = ['Unsubscribed', 'Blocked'];

function baseWhere(workspaceId: string): Prisma.ContactWhereInput {
  return {
    workspaceId,
    NOT: {
      tags: { hasSome: EXCLUDED_TAGS },
    },
  };
}

export function channelWhere(channel: CampaignAudienceChannel): Prisma.ContactWhereInput {
  switch (channel) {
    case 'whatsapp':
      return {
        AND: [{ NOT: { phone: { startsWith: 'ig:' } } }, { NOT: { phone: { startsWith: 'fb:' } } }],
      };
    case 'email':
      return {
        AND: [{ email: { not: null } }, { NOT: { email: '' } }],
      };
    case 'instagram':
      return {
        OR: [{ phone: { startsWith: 'ig:' } }, { source: 'Instagram' }],
      };
    default:
      return {};
  }
}

export async function countCampaignAudience(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentIdOrIds: string | string[] = 'all',
  tagMatchMode: TagMatchMode = 'any'
) {
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...segmentsWhere(segmentIdOrIds, tagMatchMode),
  };
  return prisma.contact.count({ where });
}

export async function getCampaignAudienceSegments(workspaceId: string, channel: CampaignAudienceChannel) {
  // One scan: collect tags + per-tag counts in memory (avoids N count queries).
  const contacts = await prisma.contact.findMany({
    where: {
      ...baseWhere(workspaceId),
      ...channelWhere(channel),
    },
    select: { tags: true },
  });

  // Businesses had no visibility into how many contacts a send silently
  // skips for being unsubscribed/blocked — surfaced here for the UI.
  const excludedCount = await prisma.contact.count({
    where: {
      workspaceId,
      ...channelWhere(channel),
      tags: { hasSome: EXCLUDED_TAGS },
    },
  });

  const tagCounts = new Map<string, number>();
  for (const contact of contacts) {
    const seen = new Set<string>();
    for (const raw of contact.tags) {
      const tag = raw.trim();
      if (!tag || EXCLUDED_TAGS.includes(tag) || seen.has(tag)) continue;
      seen.add(tag);
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const tags = Array.from(tagCounts.keys()).sort((a, b) => a.localeCompare(b));
  const allCount = contacts.length;
  const tagSegments = tags.map((tag) => ({
    id: `tag:${tag}`,
    name: tag,
    icon: 'tag',
    count: tagCounts.get(tag) ?? 0,
  }));

  return {
    channel,
    total: allCount,
    excludedCount,
    tags,
    segments: [{ id: 'all', name: 'All Contacts', icon: 'users', count: allCount }, ...tagSegments],
  };
}

export async function getCampaignAudienceContacts(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentIdOrIds: string | string[] = 'all',
  tagMatchMode: TagMatchMode = 'any'
) {
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...segmentsWhere(segmentIdOrIds, tagMatchMode),
  };
  return prisma.contact.findMany({ where, orderBy: { updatedAt: 'desc' } });
}

/**
 * Contact ids that already have a non-failed WhatsApp Message recorded for
 * this campaign. Re-running/resuming a campaign (a stuck 'running' status
 * reset, a retried request, an operator re-hitting send) must not re-message
 * contacts already successfully reached — only genuinely new/failed ones.
 */
export async function alreadyMessagedContactIdsForCampaign(
  campaignId: string,
  channel: 'whatsapp'
): Promise<Set<string>>;
export async function alreadyMessagedContactIdsForCampaign(
  campaignId: string,
  channel: 'email'
): Promise<Set<string>>;
export async function alreadyMessagedContactIdsForCampaign(
  campaignId: string,
  channel: 'whatsapp' | 'email'
): Promise<Set<string>> {
  if (channel === 'whatsapp') {
    const sent = await prisma.message.findMany({
      where: {
        status: { not: 'failed' },
        metadata: { path: ['campaignId'], equals: campaignId },
      },
      select: { conversation: { select: { contactId: true } } },
    });
    return new Set(sent.map((m) => m.conversation.contactId));
  }

  const sent = await prisma.emailLog.findMany({
    where: {
      status: { not: 'failed' },
      metadata: { path: ['campaignId'], equals: campaignId },
    },
    select: { metadata: true },
  });
  const ids = sent
    .map((log) => (log.metadata as Record<string, unknown> | null)?.contactId)
    .filter((id): id is string => typeof id === 'string');
  return new Set(ids);
}

const AUDIENCE_CONTACT_LIST_LIMIT = 200;

export async function listCampaignAudienceContacts(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentIdOrIds: string | string[] = 'all',
  tagMatchMode: TagMatchMode = 'any'
) {
  const segmentIds = normalizeSegmentIds(segmentIdOrIds);
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...segmentsWhere(segmentIds, tagMatchMode),
  };

  const [total, contacts] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: { name: 'asc' },
      take: AUDIENCE_CONTACT_LIST_LIMIT,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        tags: true,
        source: true,
      },
    }),
  ]);

  return {
    channel,
    segmentId: segmentIds[0] ?? 'all',
    segmentIds,
    total,
    truncated: total > AUDIENCE_CONTACT_LIST_LIMIT,
    limit: AUDIENCE_CONTACT_LIST_LIMIT,
    contacts,
  };
}
