import { FastifyInstance } from 'fastify';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  connectTelegramBot,
  listTelegramAccounts,
  TelegramConnectError,
} from '../services/telegramConnect.js';
import { disconnectTelegramAccounts } from '../services/channelDisconnectCleanup.service.js';

export default async function telegramRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.post('/connect', auth, async (request, reply) => {
    const body = (request.body || {}) as { botToken?: string };
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

  fastify.get('/accounts', auth, async (request) => {
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

  fastify.delete('/disconnect', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { botId?: string };
    const body = (request.body || {}) as { botId?: string };
    const botId = query.botId || body.botId;

    const cleanup = await disconnectTelegramAccounts(workspaceId, botId ? { botId } : undefined);

    request.log.info({ workspaceId, botId, cleanup }, 'Telegram disconnected');
    return { success: true, cleanup };
  });
}
