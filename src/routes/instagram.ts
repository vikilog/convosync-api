import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  completeInstagramConnect,
  connectWorkspaceInstagram,
  InstagramConnectError,
  InstagramConnectSessionCandidate,
  InstagramSelectionRequiredError,
  listInstagramAccounts,
  previewInstagramConnect,
  resolveInstagramRedirectUri,
} from '../services/instagramConnect.js';
import { subscribeInstagramPageWebhooks } from '../services/instagramWebhookSubscribe.js';
import { syncInstagramConversationsForWorkspace, DEFAULT_MAX_CONVERSATION_PAGES } from '../services/instagramSync.js';
import {
  disconnectInstagramAccounts,
} from '../services/channelDisconnectCleanup.service.js';
import { connectMessengerFromInstagramAccounts } from '../services/messengerConnect.js';
import { syncMessengerConversationsForWorkspace } from '../services/messengerSync.js';

export default async function instagramRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/oauth/state', auth, async (request) => {
    const user = getJwtUser(request);
    const state = fastify.jwt.sign(
      {
        userId: user.userId,
        workspaceId: user.workspaceId,
        role: user.role,
        purpose: 'instagram_oauth',
      },
      { expiresIn: '15m' }
    );

    const redirectUri = resolveInstagramRedirectUri();

    return {
      state,
      redirectUri,
      jsSdkFallbackRedirectUri: redirectUri,
      suggestedRedirectUris: [redirectUri],
      oauthRedirectUri: redirectUri,
      webhookUrl: config.instagramWebhookUrl,
      webhookVerifyToken: config.meta.webhookVerifyToken,
      note:
        'Direct OAuth: user opens oauthDialogUrl, Meta redirects to redirectUri with ?code=.',
    };
  });

  fastify.post('/connect/preview', auth, async (request, reply) => {
    const body = request.body as {
      code?: string;
      redirectUri?: string;
    };
    const { workspaceId } = getJwtUser(request);

    if (!body.code) {
      return reply.code(400).send({ error: 'Missing Meta authorization code' });
    }

    try {
      const { sessionCandidates, preview, metaUserId } = await previewInstagramConnect({
        workspaceId,
        code: body.code,
        redirectUri: body.redirectUri,
      });

      const connectToken = fastify.jwt.sign(
        {
          purpose: 'instagram_connect',
          workspaceId,
          candidates: sessionCandidates,
          metaUserId,
        },
        { expiresIn: '15m' }
      );

      return reply.send({
        success: true,
        connectToken,
        ...preview,
      });
    } catch (err: unknown) {
      const graphMessage =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message || (err as Error)?.message;
      fastify.log.error({ err }, 'Instagram connect preview error');

      if (err instanceof InstagramConnectError) {
        return reply.code(400).send({
          error: 'Instagram connection failed',
          details: err.message,
          discovery: err.discovery,
        });
      }

      return reply.code(500).send({
        error: 'Instagram connection failed',
        details: graphMessage || 'Instagram connection failed',
      });
    }
  });

  fastify.post('/connect', auth, async (request, reply) => {
    const body = request.body as {
      code?: string;
      redirectUri?: string;
      pageId?: string;
      connectToken?: string;
    };
    const { workspaceId } = getJwtUser(request);

    try {
      let result;

      if (body.connectToken) {
        if (!body.pageId) {
          return reply.code(400).send({ error: 'Missing pageId for Instagram connect' });
        }

        const session = fastify.jwt.verify<{
          purpose?: string;
          workspaceId?: string;
          candidates?: InstagramConnectSessionCandidate[];
          metaUserId?: string;
        }>(body.connectToken);

        if (session.purpose !== 'instagram_connect' || session.workspaceId !== workspaceId) {
          return reply.code(400).send({ error: 'Invalid or expired Instagram connect session' });
        }
        if (!session.candidates?.length) {
          return reply.code(400).send({ error: 'Instagram connect session has no accounts' });
        }

        result = await completeInstagramConnect({
          workspaceId,
          pageId: body.pageId,
          candidates: session.candidates,
          metaUserId: session.metaUserId,
        });
      } else {
        if (!body.code) {
          return reply.code(400).send({ error: 'Missing Meta authorization code' });
        }

        result = await connectWorkspaceInstagram({
          workspaceId,
          code: body.code,
          redirectUri: body.redirectUri,
          pageId: body.pageId,
        });
      }

      const account = await prisma.instagramAccount.findFirst({
        where: { workspaceId, pageId: result.pageId },
      });
      const webhookSubscribe = account
        ? await subscribeInstagramPageWebhooks(account.pageId, account.pageAccessToken)
        : { subscribed: false, error: 'Account not found after connect' };

      fastify.log.info(
        `Instagram connected for workspace ${workspaceId}: @${result.username || result.instagramUserId}`
      );

      void syncInstagramConversationsForWorkspace(workspaceId, { workspaceId })
        .then((sync) => {
          fastify.log.info(
            `Instagram inbox sync after connect: ${sync.syncedConversations} threads, ${sync.importedMessages} messages`
          );
        })
        .catch((syncErr) => fastify.log.error({ err: syncErr }, 'Instagram post-connect sync failed'));

      let messengerEnabled = false;
      try {
        const messengerResults = await connectMessengerFromInstagramAccounts(
          workspaceId,
          result.pageId
        );
        messengerEnabled = messengerResults.length > 0;
        if (messengerEnabled) {
          fastify.log.info(
            `Messenger enabled for workspace ${workspaceId} from Instagram page ${result.pageId}`
          );
          void syncMessengerConversationsForWorkspace(workspaceId, { workspaceId })
            .then((sync) => {
              fastify.log.info(
                `Messenger inbox sync after Instagram connect: ${sync.syncedConversations} threads, ${sync.importedMessages} messages`
              );
            })
            .catch((syncErr) =>
              fastify.log.error({ err: syncErr }, 'Messenger post-Instagram-connect sync failed')
            );
        }
      } catch (messengerErr) {
        fastify.log.warn(
          { err: messengerErr },
          'Messenger auto-enable skipped after Instagram connect'
        );
      }

      return reply.send({
        success: true,
        ...result,
        tokenType: result.tokenType,
        webhookSubscribe,
        messengerEnabled,
      });
    } catch (err: unknown) {
      const graphMessage =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message || (err as Error)?.message;
      fastify.log.error({ err }, 'Instagram connect error');

      if (err instanceof InstagramConnectError) {
        return reply.code(400).send({
          error: 'Instagram connection failed',
          details: err.message,
          discovery: err.discovery,
        });
      }

      if (err instanceof InstagramSelectionRequiredError) {
        return reply.code(409).send({
          error: 'Instagram account selection required',
          details: err.message,
          requiresSelection: true,
          candidates: err.candidates,
        });
      }

      return reply.code(500).send({
        error: 'Instagram connection failed',
        details: graphMessage || 'Instagram connection failed',
      });
    }
  });

  fastify.get('/accounts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const accounts = await listInstagramAccounts(workspaceId);

    return {
      accounts: accounts.map((account) => ({
        id: account.id,
        instagramUserId: account.instagramUserId,
        pageId: account.pageId,
        pageName: account.pageName,
        username: account.username,
        displayName: account.displayName || account.pageName || account.username,
        profilePicture: account.profilePicture,
        label: account.username ? `@${account.username}` : account.displayName || 'Instagram',
        status: 'Connected',
        verified: true,
      })),
    };
  });

  fastify.delete('/disconnect', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { instagramUserId?: string };
    const body = (request.body || {}) as { instagramUserId?: string };
    const instagramUserId = query.instagramUserId || body.instagramUserId;

    const cleanup = await disconnectInstagramAccounts(
      workspaceId,
      instagramUserId ? { instagramUserId } : undefined
    );

    request.log.info({ workspaceId, instagramUserId, cleanup }, 'Instagram disconnected');
    return { success: true, cleanup };
  });

  fastify.post('/sync', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = (request.body || {}) as { maxPages?: number };

    const syncOptions = { maxPages: body.maxPages ?? DEFAULT_MAX_CONVERSATION_PAGES, workspaceId };

    void syncInstagramConversationsForWorkspace(workspaceId, syncOptions)
      .then((sync) => {
        fastify.log.info(
          `Instagram sync finished workspace=${workspaceId}: loaded=${sync.loadedConversations} saved=${sync.syncedConversations} messages=${sync.importedMessages}`
        );
      })
      .catch((syncErr) => {
        fastify.log.error({ err: syncErr }, 'Instagram background sync failed');
      });

    return reply.send({
      success: true,
      status: 'started',
      message: 'Instagram sync started. Progress updates via socket.',
    });
  });
}
