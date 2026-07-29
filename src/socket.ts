import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { corsOriginDelegate } from './lib/cors.js';

export const PLATFORM_ROOM = 'platform';

export let io: Server | null = null;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: corsOriginDelegate, credentials: true },
  });

  io.on('connection', (socket) => {
    socket.on('join-workspace', (workspaceId: string) => {
      if (typeof workspaceId === 'string' && workspaceId.trim()) {
        socket.join(workspaceId);
      }
    });

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
