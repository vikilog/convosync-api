import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { listPresence } from '../services/teamPresence.js';
import {
  createTeamChatMessage,
  listDmMessages,
  listTeamChatPeers,
} from '../services/teamChat.service.js';
import {
  teamChatMessageCreateSchema,
  teamChatMessagesQuerySchema,
} from './teamChat.schemas.js';

export default async function teamChatRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/peers', { onRequest: auth.onRequest }, async (request) => {
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

  app.get(
    '/messages',
    { onRequest: auth.onRequest, schema: { querystring: teamChatMessagesQuerySchema } },
    async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const q = request.query;

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

  app.post(
    '/messages',
    { onRequest: auth.onRequest, schema: { body: teamChatMessageCreateSchema } },
    async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const body = request.body;

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

  app.get('/presence', { onRequest: auth.onRequest }, async (request) => {
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
