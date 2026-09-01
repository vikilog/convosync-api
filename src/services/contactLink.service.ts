import { randomUUID } from 'node:crypto';
import { prisma } from '../index.js';
import {
  isInstagramPhone,
  isInstagramSource,
  isMessengerPhone,
  isMessengerSource,
  type ContactChannelFilter,
} from '../lib/channelContact.js';
import { getContactAudits } from './contact-audit.service.js';
import { getContactLeadJourney } from './leadJourney.js';
import { igUsernamesForContactGroup } from './contactIgUsernames.js';

export type ContactChannel = ContactChannelFilter;

export function channelForContact(contact: {
  phone: string;
  source?: string | null;
}): ContactChannel {
  if (isInstagramPhone(contact.phone) || isInstagramSource(contact.source)) return 'instagram';
  if (isMessengerPhone(contact.phone) || isMessengerSource(contact.source)) return 'messenger';
  return 'whatsapp';
}

export type LinkedChannelRow = {
  contactId: string;
  channel: ContactChannel;
  name: string;
  phone: string;
  email: string | null;
  source: string | null;
};

export async function listContactLinks(workspaceId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      source: true,
      linkGroupId: true,
    },
  });
  if (!contact) return null;

  const members = contact.linkGroupId
    ? await prisma.contact.findMany({
        where: { workspaceId, linkGroupId: contact.linkGroupId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          source: true,
          linkGroupId: true,
        },
        orderBy: { createdAt: 'asc' },
      })
    : [contact];

  const channels: LinkedChannelRow[] = members.map((m) => ({
    contactId: m.id,
    channel: channelForContact(m),
    name: m.name,
    phone: m.phone,
    email: m.email,
    source: m.source,
  }));

  return {
    groupId: contact.linkGroupId,
    channels,
  };
}

export async function linkContacts(
  workspaceId: string,
  contactId: string,
  otherContactId: string
) {
  if (contactId === otherContactId) throw new Error('Cannot link a contact to itself');

  const [a, b] = await Promise.all([
    prisma.contact.findFirst({ where: { id: contactId, workspaceId } }),
    prisma.contact.findFirst({ where: { id: otherContactId, workspaceId } }),
  ]);
  if (!a || !b) throw new Error('Contact not found');

  const channelA = channelForContact(a);
  const channelB = channelForContact(b);
  if (channelA === channelB) {
    throw new Error(`Both contacts are already on ${channelA} — link a different channel`);
  }

  // Gather current group members for A (or just A)
  const groupA = a.linkGroupId
    ? await prisma.contact.findMany({
        where: { workspaceId, linkGroupId: a.linkGroupId },
      })
    : [a];
  const groupB = b.linkGroupId
    ? await prisma.contact.findMany({
        where: { workspaceId, linkGroupId: b.linkGroupId },
      })
    : [b];

  const channelsInA = new Set(groupA.map(channelForContact));
  if (channelsInA.has(channelB)) {
    throw new Error(`This person already has a ${channelB} contact linked`);
  }
  const channelsInB = new Set(groupB.map(channelForContact));
  if (channelsInB.has(channelA)) {
    throw new Error(`The other contact’s group already has a ${channelA} contact`);
  }

  // Merge groups: prefer existing group id from A, else B, else mint
  const groupId = a.linkGroupId || b.linkGroupId || randomUUID();
  const ids = [...new Set([...groupA.map((c) => c.id), ...groupB.map((c) => c.id)])];

  await prisma.contact.updateMany({
    where: { workspaceId, id: { in: ids } },
    data: { linkGroupId: groupId },
  });

  return listContactLinks(workspaceId, contactId);
}

export async function unlinkContact(
  workspaceId: string,
  contactId: string,
  otherContactId: string
) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: { id: true, linkGroupId: true },
  });
  if (!contact) throw new Error('Contact not found');
  if (!contact.linkGroupId) throw new Error('Contact is not linked to any channel');

  const other = await prisma.contact.findFirst({
    where: {
      id: otherContactId,
      workspaceId,
      linkGroupId: contact.linkGroupId,
    },
    select: { id: true },
  });
  if (!other) throw new Error('Linked contact not found in this group');

  // Remove the other from the group
  await prisma.contact.update({
    where: { id: otherContactId },
    data: { linkGroupId: null },
  });

  const remaining = await prisma.contact.count({
    where: { workspaceId, linkGroupId: contact.linkGroupId },
  });
  // Orphan singleton — clear group id
  if (remaining <= 1) {
    await prisma.contact.updateMany({
      where: { workspaceId, linkGroupId: contact.linkGroupId },
      data: { linkGroupId: null },
    });
  }

  return listContactLinks(workspaceId, contactId);
}

export async function getContactOverview(workspaceId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
  });
  if (!contact) return null;

  const links = await listContactLinks(workspaceId, contactId);
  const memberIds = links?.channels.map((c) => c.contactId) ?? [contactId];
  const channelRows = links?.channels ?? [];

  const [conversationCounts, auditsList, journey] = await Promise.all([
    prisma.conversation.groupBy({
      by: ['contactId'],
      where: { workspaceId, contactId: { in: memberIds } },
      _count: { _all: true },
    }),
    Promise.all(memberIds.map((id) => getContactAudits(workspaceId, id))),
    getContactLeadJourney(workspaceId, contactId),
  ]);

  const usernames = igUsernamesForContactGroup({
    channels: channelRows,
    journeyUsername: journey?.origin?.username ?? null,
  });

  const instagramCommentRows =
    usernames.length > 0
      ? await prisma.socialComment.findMany({
          where: {
            workspaceId,
            OR: usernames.map((u) => ({
              commenterUsername: { equals: u, mode: 'insensitive' as const },
            })),
          },
          select: {
            id: true,
            postId: true,
            commentText: true,
            postCaption: true,
            postThumbnailUrl: true,
            commentedAt: true,
            createdAt: true,
            intent: true,
            status: true,
            commenterUsername: true,
          },
          orderBy: [{ commentedAt: 'desc' }, { createdAt: 'desc' }],
          take: 50,
        })
      : [];

  const convByContact = new Map(
    conversationCounts.map((r) => [r.contactId, r._count._all])
  );

  const campaignMap = new Map<
    string,
    { id: string; title: string; subtitle?: string; status?: string; timestamp: string }
  >();
  let journeys = 0;
  let bots = 0;
  let aiReplies = 0;
  let templates = 0;

  for (const audits of auditsList) {
    if (!audits) continue;
    journeys += audits.summary.journeys;
    bots += audits.summary.bots;
    aiReplies += audits.summary.aiReplies;
    templates += audits.summary.templates;
    for (const ev of audits.events) {
      if (ev.type !== 'campaign') continue;
      const key = ev.id;
      const existing = campaignMap.get(key);
      if (!existing) {
        campaignMap.set(key, {
          id: key.replace(/^campaign-/, ''),
          title: ev.title,
          subtitle: ev.subtitle,
          status: ev.status,
          timestamp: ev.timestamp,
        });
        continue;
      }
      // Prefer email delivery insight (Opened/Clicked/…) over generic Sent
      if (
        existing.status === 'Sent' &&
        ev.status &&
        ev.status !== 'Sent'
      ) {
        existing.status = ev.status;
        if (ev.subtitle) existing.subtitle = ev.subtitle;
      }
    }
  }

  const campaigns = [...campaignMap.values()].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const instagramComments = instagramCommentRows.map((r) => ({
    id: r.id,
    postId: r.postId,
    commentText: r.commentText,
    postCaption: r.postCaption,
    postThumbnailUrl: r.postThumbnailUrl,
    commentedAt: (r.commentedAt ?? r.createdAt).toISOString(),
    intent: r.intent,
    status: r.status,
    commenterUsername: r.commenterUsername,
  }));

  return {
    contact: {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      avatar: contact.avatar,
      source: contact.source,
      tags: contact.tags,
      customFields: contact.customFields,
      excludeFromInsights: contact.excludeFromInsights,
      automationsPaused: contact.automationsPaused,
      linkGroupId: contact.linkGroupId,
      channel: channelForContact(contact),
      createdAt: contact.createdAt.toISOString(),
      updatedAt: contact.updatedAt.toISOString(),
    },
    links: links ?? { groupId: null, channels: [] },
    channels: channelRows.map((c) => ({
      ...c,
      conversationCount: convByContact.get(c.contactId) ?? 0,
    })),
    stats: {
      campaigns: campaigns.length,
      journeys,
      bots,
      aiReplies,
      templates,
      conversations: [...convByContact.values()].reduce((s, n) => s + n, 0),
      instagramComments: instagramComments.length,
    },
    campaigns,
    instagramComments,
    journey,
  };
}
