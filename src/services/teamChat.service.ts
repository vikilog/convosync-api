import { prisma } from '../lib/prisma.js';
import { userHasWorkspaceAccess } from './workspaceMembership.js';

export function dmPairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function serializeTeamChatMessage(row: {
  id: string;
  workspaceId: string;
  senderUserId: string;
  recipientUserId: string;
  dmPairKey: string;
  body: string;
  createdAt: Date;
  sender: { id: string; name: string; avatar: string | null };
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    recipientUserId: row.recipientUserId,
    dmPairKey: row.dmPairKey,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    sender: {
      id: row.sender.id,
      name: row.sender.name,
      avatar: row.sender.avatar,
    },
  };
}

export type TeamChatPeer = {
  userId: string;
  name: string;
  avatar: string | null;
  online: boolean;
  lastMessage: {
    id: string;
    body: string;
    createdAt: string;
    senderUserId: string;
  } | null;
};

export async function listTeamChatPeers(input: {
  workspaceId: string;
  selfUserId: string;
  onlineUserIds: Set<string>;
}): Promise<TeamChatPeer[]> {
  const memberships = await prisma.workspaceMembership.findMany({
    where: {
      workspaceId: input.workspaceId,
      userId: { not: input.selfUserId },
    },
    include: {
      user: { select: { id: true, name: true, avatar: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // ponytail: scan recent DMs in JS — ceiling ~hundreds of msgs / small teams;
  // upgrade to DISTINCT ON / lateral join when team size or history grows.
  // Preview is optional: never fail the member list if DM history/query is broken.
  const lastByPeer = new Map<
    string,
    { id: string; body: string; createdAt: string; senderUserId: string }
  >();
  try {
    const recent = await prisma.teamChatMessage.findMany({
      where: {
        workspaceId: input.workspaceId,
        OR: [
          { senderUserId: input.selfUserId },
          { recipientUserId: input.selfUserId },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        body: true,
        createdAt: true,
        senderUserId: true,
        recipientUserId: true,
      },
    });
    for (const m of recent) {
      const peerId =
        m.senderUserId === input.selfUserId ? m.recipientUserId : m.senderUserId;
      if (lastByPeer.has(peerId)) continue;
      lastByPeer.set(peerId, {
        id: m.id,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        senderUserId: m.senderUserId,
      });
    }
  } catch {
    // Membership list still returns; previews stay null until DM schema/client is healthy.
  }

  const peers: TeamChatPeer[] = memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    avatar: m.user.avatar,
    online: input.onlineUserIds.has(m.user.id),
    lastMessage: lastByPeer.get(m.user.id) ?? null,
  }));

  peers.sort((a, b) => {
    const at = a.lastMessage ? Date.parse(a.lastMessage.createdAt) : 0;
    const bt = b.lastMessage ? Date.parse(b.lastMessage.createdAt) : 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });

  return peers;
}

export async function listDmMessages(input: {
  workspaceId: string;
  selfUserId: string;
  peerUserId: string;
  limit: number;
  before?: string;
}) {
  if (input.peerUserId === input.selfUserId) {
    throw new Error('Cannot open a chat with yourself');
  }
  const allowed = await userHasWorkspaceAccess(input.peerUserId, input.workspaceId);
  if (!allowed) throw new Error('Recipient is not a workspace member');

  const pair = dmPairKey(input.selfUserId, input.peerUserId);
  const rows = await prisma.teamChatMessage.findMany({
    where: { workspaceId: input.workspaceId, dmPairKey: pair },
    orderBy: { createdAt: 'desc' },
    take: input.limit,
    ...(input.before
      ? {
          cursor: { id: input.before },
          skip: 1,
        }
      : {}),
    include: {
      sender: { select: { id: true, name: true, avatar: true } },
    },
  });

  return rows.reverse().map(serializeTeamChatMessage);
}

export async function createTeamChatMessage(input: {
  workspaceId: string;
  senderUserId: string;
  recipientUserId: string;
  body: string;
}) {
  const body = input.body.trim();
  if (!body) throw new Error('Message body is required');
  if (body.length > 4000) throw new Error('Message too long');
  if (input.recipientUserId === input.senderUserId) {
    throw new Error('Cannot message yourself');
  }

  const allowed = await userHasWorkspaceAccess(input.recipientUserId, input.workspaceId);
  if (!allowed) throw new Error('Recipient is not a workspace member');

  const pair = dmPairKey(input.senderUserId, input.recipientUserId);
  const row = await prisma.teamChatMessage.create({
    data: {
      workspaceId: input.workspaceId,
      senderUserId: input.senderUserId,
      recipientUserId: input.recipientUserId,
      dmPairKey: pair,
      body,
    },
    include: {
      sender: { select: { id: true, name: true, avatar: true } },
    },
  });

  const payload = serializeTeamChatMessage(row);

  try {
    const { getIo } = await import('../socket.js');
    const io = getIo();
    // Targeted delivery — both participants' user rooms (not whole workspace).
    io.to(`user:${input.senderUserId}`).emit('team_chat_message', payload);
    io.to(`user:${input.recipientUserId}`).emit('team_chat_message', payload);
  } catch {
    // Socket not ready
  }

  return payload;
}
