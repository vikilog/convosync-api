import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { listPresence } from '../services/teamPresence.js';
import {
  createTeamChatMessage,
  listDmMessages,
  listTeamChatPeers,
} from '../services/teamChat.service.js';

export default async function teamChatRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/peers', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId, userId } = getJwtUser(request);
    const online = listPresence(workspaceId);
    const onlineUserIds = new Set(online.map((m) => m.userId));
    const peers = await listTeamChatPeers({
      workspaceId,
      selfUserId: userId,
      onlineUserIds,
    });
    return { peers };
  });

  fastify.get('/messages', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const q = z
      .object({
        peerUserId: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        before: z.string().optional(),
      })
      .parse(request.query);

    try {
      const items = await listDmMessages({
        workspaceId,
        selfUserId: userId,
        peerUserId: q.peerUserId,
        limit: q.limit ?? 50,
        before: q.before,
      });
      return { items };
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to load messages',
      });
    }
  });

  fastify.post('/messages', { onRequest: auth.onRequest }, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const body = z
      .object({
        body: z.string().min(1).max(4000),
        recipientUserId: z.string().min(1),
      })
      .parse(request.body);

    try {
      const message = await createTeamChatMessage({
        workspaceId,
        senderUserId: userId,
        recipientUserId: body.recipientUserId,
        body: body.body,
      });
      return reply.code(201).send(message);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to send',
      });
    }
  });

  fastify.get('/presence', { onRequest: auth.onRequest }, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const members = listPresence(workspaceId);
    return {
      online: members.map((m) => ({
        userId: m.userId,
        name: m.name,
        avatar: m.avatar,
      })),
      onlineCount: members.length,
    };
  });
}
