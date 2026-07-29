import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { decryptSecret } from '../lib/field-encryption.js';
import { getJwtUser, type JwtUser } from '../middleware/auth.js';
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
import {
  getListeningProfile,
  listListeningMedia,
  getListeningMediaDetail,
  listListeningComments,
  replyToListeningComment,
} from '../services/instagramListening.service.js';
import {
  triggerClassifyAfterUpsert,
  upsertListeningCommentsForPost,
} from '../services/socialCommentSync.service.js';

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

  /** Convenience: returns ready-to-open Facebook OAuth dialog URL (scopes include comments + messages). */
  fastify.get('/connect', auth, async (request, reply) => {
    if (!config.meta.appId) {
      return reply.code(500).send({ error: 'META_APP_ID is not configured' });
    }
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
    const scope = [
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_manage_messages',
      'pages_show_list',
      'pages_read_engagement',
      'business_management',
      'pages_manage_metadata',
      'pages_messaging',
    ].join(',');
    const url = new URL('https://www.facebook.com/v19.0/dialog/oauth');
    url.searchParams.set('client_id', config.meta.appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', scope);
    url.searchParams.set('response_type', 'code');
    return {
      oauthDialogUrl: url.toString(),
      redirectUri,
      state,
      scopes: scope.split(','),
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
        } as JwtUser & { candidates: unknown; metaUserId?: string },
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
    const { workspaceId, userId } = getJwtUser(request);

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
          connectedByUserId: userId,
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
          connectedByUserId: userId,
        });
      }

      const account = await prisma.instagramAccount.findFirst({
        where: { workspaceId, pageId: result.pageId },
      });
      const pageAccessToken = decryptSecret(account?.pageAccessToken);
      const webhookSubscribe =
        account && pageAccessToken
          ? await subscribeInstagramPageWebhooks(
              account.pageId,
              pageAccessToken,
              account.instagramUserId
            )
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

      // Messenger is a separate Integrations step — do not auto-enable on IG connect.
      return reply.send({
        success: true,
        ...result,
        tokenType: result.tokenType,
        webhookSubscribe,
        messengerEnabled: false,
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
        statusLabel: account.statusLabel,
        verified: true,
      })),
    };
  });

  fastify.get('/listening/profile', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { instagramUserId?: string };

    try {
      const profile = await getListeningProfile(workspaceId, query.instagramUserId);
      return reply.send({ profile });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load Instagram profile';
      const notConnected = /not connected/i.test(message);
      return reply.code(notConnected ? 404 : 502).send({
        error: notConnected ? 'Instagram not connected' : 'Failed to load Instagram profile',
        details: message,
      });
    }
  });

  fastify.get('/listening/media', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as {
      instagramUserId?: string;
      after?: string;
      limit?: string;
    };
    const limit = query.limit ? Number(query.limit) : undefined;

    try {
      const page = await listListeningMedia(workspaceId, {
        instagramUserId: query.instagramUserId,
        after: query.after,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return reply.send(page);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load Instagram media';
      const notConnected = /not connected/i.test(message);
      return reply.code(notConnected ? 404 : 502).send({
        error: notConnected ? 'Instagram not connected' : 'Failed to load Instagram media',
        details: message,
      });
    }
  });

  fastify.get('/listening/media/:mediaId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const query = request.query as { instagramUserId?: string };

    try {
      const media = await getListeningMediaDetail(workspaceId, mediaId, query.instagramUserId);
      return reply.send({ media });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load media';
      const notConnected = /not connected/i.test(message);
      return reply.code(notConnected ? 404 : 502).send({
        error: notConnected ? 'Instagram not connected' : 'Failed to load media',
        details: message,
      });
    }
  });

  fastify.get('/listening/media/:mediaId/comments', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { mediaId } = request.params as { mediaId: string };
    const query = request.query as {
      instagramUserId?: string;
      after?: string;
      limit?: string;
    };
    const limit = query.limit ? Number(query.limit) : undefined;

    try {
      const page = await listListeningComments(workspaceId, mediaId, {
        instagramUserId: query.instagramUserId,
        after: query.after,
        limit: Number.isFinite(limit) ? limit : undefined,
      });

      let postCaption: string | null = null;
      let postThumbnailUrl: string | null = null;
      try {
        const media = await getListeningMediaDetail(
          workspaceId,
          mediaId,
          query.instagramUserId
        );
        postCaption = media.caption;
        postThumbnailUrl = media.thumbnailUrl || media.mediaUrl;
      } catch {
        // non-fatal — classification upsert still works without post meta
      }

      const { enriched, pendingClassifyIds } = await upsertListeningCommentsForPost({
        workspaceId,
        instagramUserId: query.instagramUserId,
        postId: mediaId,
        comments: page.comments,
        postCaption,
        postThumbnailUrl,
      });
      triggerClassifyAfterUpsert(workspaceId, pendingClassifyIds);

      return reply.send({
        comments: enriched,
        nextCursor: page.nextCursor,
        classifying: pendingClassifyIds.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load comments';
      const notConnected = /not connected/i.test(message);
      return reply.code(notConnected ? 404 : 502).send({
        error: notConnected ? 'Instagram not connected' : 'Failed to load comments',
        details: message,
      });
    }
  });

  fastify.post('/listening/comments/:commentId/reply', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { commentId } = request.params as { commentId: string };
    const body = (request.body || {}) as { message?: string; instagramUserId?: string };

    if (!body.message?.trim()) {
      return reply.code(400).send({ error: 'Reply message is required' });
    }

    try {
      const result = await replyToListeningComment(
        workspaceId,
        commentId,
        body.message,
        body.instagramUserId
      );
      return reply.send({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reply';
      const notConnected = /not connected/i.test(message);
      return reply.code(notConnected ? 404 : 502).send({
        error: notConnected ? 'Instagram not connected' : 'Failed to reply',
        details: message,
      });
    }
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
    const body = (request.body || {}) as { maxPages?: number; loadMore?: boolean };

    const syncOptions = {
      maxPages: body.maxPages ?? DEFAULT_MAX_CONVERSATION_PAGES,
      workspaceId,
      loadMore: Boolean(body.loadMore),
    };

    void syncInstagramConversationsForWorkspace(workspaceId, syncOptions)
      .then((sync) => {
        fastify.log.info(
          `Instagram sync finished workspace=${workspaceId}: loaded=${sync.loadedConversations} saved=${sync.syncedConversations} messages=${sync.importedMessages} hasMore=${sync.hasMore}`
        );
      })
      .catch((syncErr) => {
        // Don't log full AxiosError — config.url embeds the page access token.
        const ax = syncErr as { code?: string; message?: string };
        fastify.log.error(
          {
            code: ax?.code,
            message: ax?.message || (syncErr instanceof Error ? syncErr.message : String(syncErr)),
            workspaceId,
          },
          'Instagram background sync failed'
        );
      });

    return reply.send({
      success: true,
      status: 'started',
      message: body.loadMore
        ? 'Loading more Instagram chats…'
        : 'Instagram sync started. Progress updates via socket.',
    });
  });
}
