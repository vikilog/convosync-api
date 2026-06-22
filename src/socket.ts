import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { corsOriginDelegate } from './lib/cors.js';

export let io: Server | null = null;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: corsOriginDelegate, credentials: true },
  });

  io.on('connection', (socket) => {
    socket.on('join-workspace', (workspaceId: string) => {
      socket.join(workspaceId);
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
