/**
 * Workspace presence for team chat online dots.
 * Reuses the existing Socket.IO workspace room join path — no parallel Redis presence bus.
 *
 * ponytail: in-process map — ceiling single Node instance; upgrade to Redis HASH+TTL
 * when running multiple API replicas that share the same socket adapter.
 */

export type PresenceMember = {
  userId: string;
  name: string;
  avatar: string | null;
  socketId: string;
  joinedAt: number;
};

const byWorkspace = new Map<string, Map<string, PresenceMember>>();

export function presenceJoin(
  workspaceId: string,
  member: Omit<PresenceMember, 'joinedAt'>
): PresenceMember[] {
  let room = byWorkspace.get(workspaceId);
  if (!room) {
    room = new Map();
    byWorkspace.set(workspaceId, room);
  }
  room.set(member.userId, { ...member, joinedAt: Date.now() });
  return listPresence(workspaceId);
}

export function presenceLeave(workspaceId: string, userId: string, socketId?: string): PresenceMember[] {
  const room = byWorkspace.get(workspaceId);
  if (!room) return [];
  const current = room.get(userId);
  if (current && socketId && current.socketId !== socketId) {
    return listPresence(workspaceId);
  }
  room.delete(userId);
  if (room.size === 0) byWorkspace.delete(workspaceId);
  return listPresence(workspaceId);
}

export function presenceLeaveSocket(socketId: string): Array<{ workspaceId: string; members: PresenceMember[] }> {
  const touched: Array<{ workspaceId: string; members: PresenceMember[] }> = [];
  for (const [workspaceId, room] of byWorkspace) {
    for (const [userId, member] of room) {
      if (member.socketId === socketId) {
        room.delete(userId);
        if (room.size === 0) byWorkspace.delete(workspaceId);
        touched.push({ workspaceId, members: listPresence(workspaceId) });
        break;
      }
    }
  }
  return touched;
}

export function listPresence(workspaceId: string): PresenceMember[] {
  const room = byWorkspace.get(workspaceId);
  if (!room) return [];
  return [...room.values()].sort((a, b) => a.name.localeCompare(b.name));
}
