import type { Prisma } from '@prisma/client';
import { prisma } from '../index.js';

export type CampaignAudienceChannel = 'whatsapp' | 'email' | 'instagram';

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

function segmentWhere(segmentId: string): Prisma.ContactWhereInput {
  if (segmentId.startsWith('tag:')) {
    const tag = segmentId.slice(4);
    if (!tag) return {};
    return { tags: { has: tag } };
  }
  return {};
}

async function getWorkspaceTags(workspaceId: string): Promise<string[]> {
  const contacts = await prisma.contact.findMany({
    where: { workspaceId },
    select: { tags: true },
  });

  const tagSet = new Set<string>();
  for (const contact of contacts) {
    for (const tag of contact.tags) {
      const trimmed = tag.trim();
      if (trimmed && !EXCLUDED_TAGS.includes(trimmed)) {
        tagSet.add(trimmed);
      }
    }
  }

  return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
}

export async function countCampaignAudience(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentId = 'all'
) {
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...(segmentId !== 'all' ? segmentWhere(segmentId) : {}),
  };
  return prisma.contact.count({ where });
}

export async function getCampaignAudienceSegments(workspaceId: string, channel: CampaignAudienceChannel) {
  const tags = await getWorkspaceTags(workspaceId);
  const allCount = await countCampaignAudience(workspaceId, channel, 'all');

  const tagSegments = await Promise.all(
    tags.map(async (tag) => ({
      id: `tag:${tag}`,
      name: tag,
      icon: 'tag',
      count: await countCampaignAudience(workspaceId, channel, `tag:${tag}`),
    }))
  );

  return {
    channel,
    total: allCount,
    tags,
    segments: [{ id: 'all', name: 'All Contacts', icon: 'users', count: allCount }, ...tagSegments],
  };
}

export function segmentIdToTag(segmentId: string): string | undefined {
  if (!segmentId.startsWith('tag:')) return undefined;
  const tag = segmentId.slice(4).trim();
  return tag || undefined;
}

export async function getCampaignAudienceContacts(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentId = 'all'
) {
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...(segmentId !== 'all' ? segmentWhere(segmentId) : {}),
  };
  return prisma.contact.findMany({ where, orderBy: { updatedAt: 'desc' } });
}

const AUDIENCE_CONTACT_LIST_LIMIT = 200;

export async function listCampaignAudienceContacts(
  workspaceId: string,
  channel: CampaignAudienceChannel,
  segmentId = 'all'
) {
  const where: Prisma.ContactWhereInput = {
    ...baseWhere(workspaceId),
    ...channelWhere(channel),
    ...(segmentId !== 'all' ? segmentWhere(segmentId) : {}),
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
    segmentId,
    total,
    truncated: total > AUDIENCE_CONTACT_LIST_LIMIT,
    limit: AUDIENCE_CONTACT_LIST_LIMIT,
    contacts,
  };
}
