import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { corsOriginDelegate } from './lib/cors.js';
import { prisma } from './lib/prisma.js';
import { userHasWorkspaceAccess } from './services/workspaceMembership.js';
import {
  listPresence,
  presenceJoin,
  presenceLeave,
  presenceLeaveSocket,
} from './services/teamPresence.js';
import { createTeamChatMessage } from './services/teamChat.service.js';

export const PLATFORM_ROOM = 'platform';

export let io: Server | null = null;

type JwtClaims = {
  userId?: string;
  workspaceId?: string;
  scope?: string;
  purpose?: string;
};

type VerifyJwt = (token: string) => JwtClaims;

let verifyJwt: VerifyJwt | null = null;

export function initSocket(httpServer: HttpServer, opts?: { verifyJwt?: VerifyJwt }): Server {
  verifyJwt = opts?.verifyJwt ?? null;

  io = new Server(httpServer, {
    cors: { origin: corsOriginDelegate, credentials: true },
  });

  io.on('connection', (socket) => {
    let boundWorkspaceId: string | null = null;
    let boundUserId: string | null = null;

    socket.on('join-workspace', async (workspaceId: string, ack?: (ok: boolean) => void) => {
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
        ack?.(false);
        return;
      }
      const wsId = workspaceId.trim();

      // Always join room for inbox realtime (legacy path).
      if (boundWorkspaceId && boundWorkspaceId !== wsId && boundUserId) {
        const members = presenceLeave(boundWorkspaceId, boundUserId, socket.id);
        socket.leave(boundWorkspaceId);
        socket.leave(`user:${boundUserId}`);
        io?.to(boundWorkspaceId).emit('team_presence', {
          online: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            avatar: m.avatar,
          })),
          onlineCount: members.length,
        });
      }

      socket.join(wsId);
      boundWorkspaceId = wsId;

      const token =
        typeof socket.handshake.auth?.token === 'string'
          ? socket.handshake.auth.token
          : '';

      if (token && verifyJwt) {
        try {
          const claims = verifyJwt(token);
          if (
            claims.userId &&
            claims.scope !== 'platform' &&
            !claims.purpose &&
            (await userHasWorkspaceAccess(claims.userId, wsId))
          ) {
            const user = await prisma.user.findUnique({
              where: { id: claims.userId },
              select: { id: true, name: true, avatar: true },
            });
            if (user) {
              boundUserId = user.id;
              socket.join(`user:${user.id}`);
              const members = presenceJoin(wsId, {
                userId: user.id,
                name: user.name,
                avatar: user.avatar,
                socketId: socket.id,
              });
              io?.to(wsId).emit('team_presence', {
                online: members.map((m) => ({
                  userId: m.userId,
                  name: m.name,
                  avatar: m.avatar,
                })),
                onlineCount: members.length,
              });
              socket.emit('team_presence', {
                online: members.map((m) => ({
                  userId: m.userId,
                  name: m.name,
                  avatar: m.avatar,
                })),
                onlineCount: members.length,
              });
            }
          }
        } catch {
          // Invalid token — room join still works for inbox; no presence
        }
      } else {
        socket.emit('team_presence', {
          online: listPresence(wsId).map((m) => ({
            userId: m.userId,
            name: m.name,
            avatar: m.avatar,
          })),
          onlineCount: listPresence(wsId).length,
        });
      }

      ack?.(true);
    });

    socket.on(
      'team_chat_send',
      async (
        payload: { body?: string; recipientUserId?: string },
        ack?: (res: unknown) => void
      ) => {
        try {
          const token =
            typeof socket.handshake.auth?.token === 'string'
              ? socket.handshake.auth.token
              : '';
          if (!token || !verifyJwt || !boundWorkspaceId) {
            ack?.({ error: 'Unauthorized' });
            return;
          }
          const claims = verifyJwt(token);
          if (!claims.userId || !(await userHasWorkspaceAccess(claims.userId, boundWorkspaceId))) {
            ack?.({ error: 'Unauthorized' });
            return;
          }
          const body = typeof payload?.body === 'string' ? payload.body : '';
          const recipientUserId =
            typeof payload?.recipientUserId === 'string' ? payload.recipientUserId : '';
          if (!recipientUserId) {
            ack?.({ error: 'recipientUserId is required' });
            return;
          }
          const message = await createTeamChatMessage({
            workspaceId: boundWorkspaceId,
            senderUserId: claims.userId,
            recipientUserId,
            body,
          });
          ack?.({ ok: true, message });
        } catch (err) {
          ack?.({ error: err instanceof Error ? err.message : 'Failed' });
        }
      }
    );

    socket.on('join-platform', () => {
      socket.join(PLATFORM_ROOM);
      void import('./services/platformInfrastructureBroadcast.js').then((m) => {
        m.ensurePlatformInfrastructureBroadcast();
        void m.pushPlatformInfrastructureOnce(socket.id);
      });
    });

    socket.on('leave-platform', () => {
      socket.leave(PLATFORM_ROOM);
    });

    socket.on('disconnect', () => {
      if (boundWorkspaceId && boundUserId) {
        const members = presenceLeave(boundWorkspaceId, boundUserId, socket.id);
        socket.leave(`user:${boundUserId}`);
        io?.to(boundWorkspaceId).emit('team_presence', {
          online: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            avatar: m.avatar,
          })),
          onlineCount: members.length,
        });
      } else {
        for (const { workspaceId, members } of presenceLeaveSocket(socket.id)) {
          io?.to(workspaceId).emit('team_presence', {
            online: members.map((m) => ({
              userId: m.userId,
              name: m.name,
              avatar: m.avatar,
            })),
            onlineCount: members.length,
          });
        }
      }
    });
  });

  return io;
}

export function getIo(): Server {
  if (!io) {
    throw new Error('Socket.IO is not initialized');
  }
  return io;
}

export function platformRoomSize(): number {
  if (!io) return 0;
  return io.sockets.adapter.rooms.get(PLATFORM_ROOM)?.size ?? 0;
}
