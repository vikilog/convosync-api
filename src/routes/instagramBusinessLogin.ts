import { FastifyInstance } from 'fastify';
import { getJwtUser, type JwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { config } from '../config.js';
import {
  buildInstagramBusinessLoginUrl,
  connectInstagramBusinessLogin,
  deleteInstagramBusinessComment,
  hideInstagramBusinessComment,
  listInstagramBusinessLoginAccounts,
  replyToInstagramBusinessComment,
} from '../services/instagramBusinessLogin.service.js';

export default async function instagramBusinessLoginRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  /** Returns a ready-to-open Instagram (not Facebook) OAuth dialog URL for the Instagram Login track. */
  fastify.get('/connect', auth, async (request, reply) => {
    if (!config.instagramBusinessLogin.appId) {
      return reply.code(500).send({ error: 'INSTAGRAM_BUSINESS_APP_ID is not configured' });
    }
    const user = getJwtUser(request);
    const state = fastify.jwt.sign(
      {
        userId: user.userId,
        workspaceId: user.workspaceId,
        role: user.role,
        purpose: 'instagram_business_login_oauth',
      } as JwtUser,
      { expiresIn: '15m' }
    );
    const redirectUri = config.instagramBusinessLogin.redirectUri;
    return {
      oauthDialogUrl: buildInstagramBusinessLoginUrl(state, redirectUri),
      redirectUri,
      state,
    };
  });

  fastify.post('/connect', auth, async (request, reply) => {
    const { workspaceId, userId } = getJwtUser(request);
    const body = request.body as { code?: string; redirectUri?: string };
    if (!body.code) return reply.code(400).send({ error: 'Missing Instagram authorization code' });

    try {
      const result = await connectInstagramBusinessLogin({
        workspaceId,
        code: body.code,
        redirectUri: body.redirectUri || config.instagramBusinessLogin.redirectUri,
        connectedByUserId: userId,
      });
      fastify.log.info(
        `Instagram (business login) connected for workspace ${workspaceId}: @${result.username || result.instagramUserId}`
      );
      return reply.send({ success: true, ...result });
    } catch (err) {
      fastify.log.error({ err }, 'Instagram business login connect error');
      return reply.code(400).send({
        error: 'Instagram connection failed',
        details: err instanceof Error ? err.message : 'Instagram connection failed',
      });
    }
  });

  fastify.get('/accounts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const accounts = await listInstagramBusinessLoginAccounts(workspaceId);
    return { accounts };
  });

  fastify.post('/comments/:commentId/reply', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { commentId } = request.params as { commentId: string };
    const body = request.body as { message?: string; instagramUserId?: string };
    if (!body.message?.trim()) return reply.code(400).send({ error: 'message is required' });
    try {
      const result = await replyToInstagramBusinessComment(
        workspaceId,
        commentId,
        body.message,
        body.instagramUserId
      );
      return reply.send({ success: true, ...result });
    } catch (err) {
      return reply.code(400).send({
        error: 'Reply failed',
        details: err instanceof Error ? err.message : 'Reply failed',
      });
    }
  });

  fastify.post('/comments/:commentId/hide', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { commentId } = request.params as { commentId: string };
    const body = request.body as { hidden?: boolean; instagramUserId?: string };
    try {
      const result = await hideInstagramBusinessComment(
        workspaceId,
        commentId,
        body.hidden ?? true,
        body.instagramUserId
      );
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({
        error: 'Hide failed',
        details: err instanceof Error ? err.message : 'Hide failed',
      });
    }
  });

  fastify.delete('/comments/:commentId', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { commentId } = request.params as { commentId: string };
    const body = (request.body || {}) as { instagramUserId?: string };
    try {
      const result = await deleteInstagramBusinessComment(workspaceId, commentId, body.instagramUserId);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({
        error: 'Delete failed',
        details: err instanceof Error ? err.message : 'Delete failed',
      });
    }
  });
}
