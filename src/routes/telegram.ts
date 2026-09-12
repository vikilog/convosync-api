import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  connectTelegramBot,
  listTelegramAccounts,
  TelegramConnectError,
} from '../services/telegramConnect.js';
import { disconnectTelegramAccounts } from '../services/channelDisconnectCleanup.service.js';
import {
  telegramConnectBodySchema,
  telegramDisconnectBodySchema,
  telegramDisconnectQuerySchema,
} from './telegram.schemas.js';

export default async function telegramRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.post(
    '/connect',
    { ...auth, schema: { body: telegramConnectBodySchema } },
    async (request, reply) => {
    const body = request.body;
    const { workspaceId } = getJwtUser(request);

    if (!body.botToken || !body.botToken.trim()) {
      return reply.code(400).send({ error: 'botToken is required' });
    }

    try {
      const result = await connectTelegramBot(workspaceId, body.botToken);
      fastify.log.info(
        `Telegram bot connected for workspace ${workspaceId}: ${result.botUsername || result.botId}`
      );
      return reply.send({ success: true, ...result });
    } catch (err: unknown) {
      if (err instanceof TelegramConnectError) {
        return reply.code(400).send({ error: 'Telegram connection failed', details: err.message });
      }
      fastify.log.error({ err }, 'Telegram connect error');
      return reply.code(500).send({ error: 'Telegram connection failed' });
    }
  });

  app.get('/accounts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const accounts = await listTelegramAccounts(workspaceId);

    return {
      accounts: accounts.map((account) => ({
        id: account.id,
        botId: account.botId,
        botUsername: account.botUsername,
        botName: account.botName,
        label: account.botUsername ? `@${account.botUsername}` : account.botName || 'Telegram bot',
      })),
    };
  });

  app.delete(
    '/disconnect',
    {
      ...auth,
      schema: { querystring: telegramDisconnectQuerySchema, body: telegramDisconnectBodySchema },
    },
    async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query;
    const body = request.body;
    const botId = query.botId || body.botId;

    const cleanup = await disconnectTelegramAccounts(workspaceId, botId ? { botId } : undefined);

    request.log.info({ workspaceId, botId, cleanup }, 'Telegram disconnected');
    return { success: true, cleanup };
  });
}
