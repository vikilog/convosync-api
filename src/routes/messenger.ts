import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  connectMessengerFromInstagramAccounts,
  listMessengerAccounts,
  MessengerConnectError,
} from '../services/messengerConnect.js';
import { subscribeInstagramPageWebhooks } from '../services/instagramWebhookSubscribe.js';
import {
  syncMessengerConversationsForWorkspace,
  DEFAULT_MAX_CONVERSATION_PAGES,
} from '../services/messengerSync.js';
import { disconnectMessengerAccounts } from '../services/channelDisconnectCleanup.service.js';

export default async function messengerRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.post('/connect', auth, async (request, reply) => {
    const body = (request.body || {}) as { pageId?: string };
    const { workspaceId } = getJwtUser(request);

    try {
      const results = await connectMessengerFromInstagramAccounts(workspaceId, body.pageId);

      const webhookResults = await Promise.all(
        results.map(async (result) => {
          const account = await prisma.messengerAccount.findFirst({
            where: { workspaceId, pageId: result.pageId },
          });
          if (!account) {
            return { pageId: result.pageId, subscribed: false, error: 'Account not found after connect' };
          }
          const webhookSubscribe = await subscribeInstagramPageWebhooks(
            account.pageId,
            account.pageAccessToken
          );
          return { pageId: result.pageId, ...webhookSubscribe };
        })
      );

      fastify.log.info(
        `Messenger enabled for workspace ${workspaceId} from Instagram token: ${results
          .map((r) => r.pageName || r.pageId)
          .join(', ')}`
      );

      void syncMessengerConversationsForWorkspace(workspaceId, { workspaceId })
        .then((sync) => {
          fastify.log.info(
            `Messenger inbox sync after connect: ${sync.syncedConversations} threads, ${sync.importedMessages} messages`
          );
        })
        .catch((syncErr) => fastify.log.error({ err: syncErr }, 'Messenger post-connect sync failed'));

      const primary = results[0];
      return reply.send({
        success: true,
        accounts: results,
        pageId: primary.pageId,
        pageName: primary.pageName,
        displayName: primary.displayName,
        profilePicture: primary.profilePicture,
        tokenType: primary.tokenType,
        webhookSubscribe: webhookResults[0],
      });
    } catch (err: unknown) {
      const graphMessage =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message || (err as Error)?.message;
      fastify.log.error({ err }, 'Messenger connect error');

      if (err instanceof MessengerConnectError) {
        return reply.code(400).send({
          error: 'Messenger connection failed',
          details: err.message,
        });
      }

      return reply.code(500).send({
        error: 'Messenger connection failed',
        details: graphMessage || 'Messenger connection failed',
      });
    }
  });

  fastify.get('/accounts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const accounts = await listMessengerAccounts(workspaceId);

    return {
      accounts: accounts.map((account) => ({
        id: account.id,
        pageId: account.pageId,
        pageName: account.pageName,
        displayName: account.displayName || account.pageName,
        profilePicture: account.profilePicture,
        label: account.displayName || account.pageName || 'Messenger',
        status: 'Connected',
        verified: true,
      })),
    };
  });

  fastify.delete('/disconnect', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { pageId?: string };
    const body = (request.body || {}) as { pageId?: string };
    const pageId = query.pageId || body.pageId;

    const cleanup = await disconnectMessengerAccounts(
      workspaceId,
      pageId ? { pageId } : undefined
    );

    request.log.info({ workspaceId, pageId, cleanup }, 'Messenger disconnected');
    return { success: true, cleanup };
  });

  fastify.post('/sync', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = (request.body || {}) as { maxPages?: number };

    const syncOptions = { maxPages: body.maxPages ?? DEFAULT_MAX_CONVERSATION_PAGES, workspaceId };

    void syncMessengerConversationsForWorkspace(workspaceId, syncOptions)
      .then((sync) => {
        fastify.log.info(
          `Messenger sync finished workspace=${workspaceId}: loaded=${sync.loadedConversations} saved=${sync.syncedConversations} messages=${sync.importedMessages}`
        );
      })
      .catch((syncErr) => {
        fastify.log.error({ err: syncErr }, 'Messenger background sync failed');
      });

    return reply.send({
      success: true,
      status: 'started',
      message: 'Messenger sync started. Progress updates via socket.',
    });
  });
}
