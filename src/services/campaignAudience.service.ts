import type { Prisma } from '@prisma/client';
import { prisma } from '../index.js';
import { normalizeSegmentIds, segmentsWhere } from './campaignAudienceFilter.js';

export type CampaignAudienceChannel = 'whatsapp' | 'email' | 'instagram';

export {
  audienceTagFromIds,
  normalizeSegmentIds,
  resolveSegmentIdsFromFilter,
  segmentIdToTag,
  segmentLabelFromIds,
  segmentsWhere,
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
  segmentIdOrIds: string | string[] = 'all'
) {
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...segmentsWhere(segmentIdOrIds),
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
    tags,
    segments: [{ id: 'all', name: 'All Contacts', icon: 'users', count: allCount }, ...tagSegments],
  };
}

export async function getCampaignAudienceContacts(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentIdOrIds: string | string[] = 'all'
) {
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...segmentsWhere(segmentIdOrIds),
  };
  return prisma.contact.findMany({ where, orderBy: { updatedAt: 'desc' } });
}

const AUDIENCE_CONTACT_LIST_LIMIT = 200;

export async function listCampaignAudienceContacts(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentIdOrIds: string | string[] = 'all'
) {
  const segmentIds = normalizeSegmentIds(segmentIdOrIds);
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...segmentsWhere(segmentIds),
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
