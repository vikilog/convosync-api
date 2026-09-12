import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate, getJwtUser } from '../../middleware/auth.js';
import { requireWorkspaceAccess } from '../../middleware/workspaceScope.js';
import { resolveMembershipAccess } from '../../services/workspaceMemberAdmin.js';
import {
  changeUserPassword,
  updateUserAvatar,
  updateUserProfile,
} from '../../services/userProfile.js';
import { onboardingPayloadFromUser } from '../../services/onboarding.js';
import {
  blacklistJti,
  bumpTokenVersion,
  ensureUserSecurityState,
  JtiBlacklistUnavailableError,
  signSessionToken,
} from '../../services/userSecurity.js';
import {
  requestPasswordReset,
  resetPasswordWithToken,
  verifyResetCode,
} from '../../services/passwordReset.service.js';
import {
  changePasswordBodySchema,
  createWorkspaceBodySchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  patchAvatarBodySchema,
  patchProfileBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  switchWorkspaceBodySchema,
  verifyResetCodeBodySchema,
} from '../../routes/auth.schemas.js';
import { getMe } from './identity.controller.js';
import { sessionUserView } from './identity.helpers.js';
import * as identityService from './identity.service.js';

async function replyServiceError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  const message = err instanceof Error ? err.message : 'Request failed';
  const status =
    /too many|incorrect|expired|no account found|not requested|not configured|valid mobile|add a mobile|changed since|nothing to update/i.test(
      message
    )
      ? 400
      : 500;
  return reply.code(status).send({ error: message });
}

const authAbuseLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export default async function authRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/register', { ...authAbuseLimit, schema: { body: registerBodySchema } }, async (request, reply) => {
    const created = await identityService.registerAccount(request.body);
    if (!created.ok) return reply.code(created.status).send({ error: created.error });

    const token = await signSessionToken(fastify, {
      userId: created.user.id,
      workspaceId: created.workspace.id,
    });
    const access = await resolveMembershipAccess(created.user.id, created.workspace.id);

    return {
      token,
      user: sessionUserView(created.user, access, onboardingPayloadFromUser(created.user)),
      workspace: created.workspace,
      workspaces: created.workspaces,
      activeWorkspaceId: created.workspace.id,
    };
  });

  app.post('/login', { ...authAbuseLimit, schema: { body: loginBodySchema } }, async (request, reply) => {
    const body = request.body;
    const creds = await identityService.verifyLoginCredentials(body.email, body.password);
    if (!creds.ok) return reply.code(401).send({ error: 'Invalid credentials' });

    await ensureUserSecurityState(creds.user.id);

    const session = await identityService.resolveLoginWorkspace(creds.user, body.workspaceId);
    if (!session.ok) return reply.code(session.status).send({ error: session.error });

    const token = await signSessionToken(fastify, {
      userId: creds.user.id,
      workspaceId: session.activeWorkspaceId,
    });
    const access = await resolveMembershipAccess(creds.user.id, session.activeWorkspaceId);

    return {
      token,
      user: sessionUserView(creds.user, access, onboardingPayloadFromUser(creds.user)),
      workspace: session.activeWorkspace,
      workspaces: session.workspaces,
      activeWorkspaceId: session.activeWorkspaceId,
    };
  });

  app.post(
    '/forgot-password',
    { ...authAbuseLimit, schema: { body: forgotPasswordBodySchema } },
    async (request, reply) => {
    try {
      await requestPasswordReset(request.body.email);
    } catch (err) {
      return replyServiceError(reply, err);
    }
    return { message: 'Reset code sent to your email.' };
  });

  app.post(
    '/verify-reset-code',
    { ...authAbuseLimit, schema: { body: verifyResetCodeBodySchema } },
    async (request, reply) => {
    try {
      return await verifyResetCode(request.body);
    } catch (err) {
      return replyServiceError(reply, err);
    }
  });

  app.post(
    '/reset-password',
    { ...authAbuseLimit, schema: { body: resetPasswordBodySchema } },
    async (request, reply) => {
    try {
      await resetPasswordWithToken(request.body);
    } catch (err) {
      return replyServiceError(reply, err);
    }
    return { success: true };
  });

  /** Logout this device — blacklist jti until JWT exp (Redis). */
  app.post('/logout', { onRequest: [authenticate] }, async (request, reply) => {
    const user = getJwtUser(request);
    if (!user.jti || !user.exp) {
      return reply.code(400).send({
        error: 'Token missing jti/exp; re-login then logout again',
        code: 'token_missing_jti',
      });
    }

    try {
      await blacklistJti(user.jti, user.exp);
    } catch (err) {
      if (err instanceof JtiBlacklistUnavailableError) {
        return reply.code(503).send({
          error: err.message,
          code: 'logout_retry',
        });
      }
      throw err;
    }

    return { success: true };
  });

  /** Logout everywhere — bump tokenVersion (Postgres). */
  app.post(
    '/logout-all',
    { onRequest: [authenticate, requireWorkspaceAccess] },
    async (request) => {
      const { userId } = getJwtUser(request);
      if (!userId) return { success: false };
      const tokenVersion = await bumpTokenVersion(userId, 'logout_all');
      return { success: true, tokenVersion };
    }
  );

  app.get('/workspaces', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    return identityService.listWorkspacesForUser(userId, workspaceId);
  });

  app.post(
    '/switch-workspace',
    { onRequest: [authenticate, requireWorkspaceAccess], schema: { body: switchWorkspaceBodySchema } },
    async (request, reply) => {
    const { userId } = getJwtUser(request);
    const loaded = await identityService.loadSwitchWorkspace(userId, request.body.workspaceId);
    if (!loaded.ok) return reply.code(loaded.status).send({ error: loaded.error });

    const token = await signSessionToken(fastify, {
      userId,
      workspaceId: loaded.workspace.id,
    });
    const access = await resolveMembershipAccess(userId, loaded.workspace.id);

    return {
      token,
      workspace: loaded.workspace,
      workspaces: loaded.workspaces,
      activeWorkspaceId: loaded.workspace.id,
      user: sessionUserView(loaded.user, access),
    };
  });

  app.post(
    '/workspaces',
    { onRequest: [authenticate, requireWorkspaceAccess], schema: { body: createWorkspaceBodySchema } },
    async (request, reply) => {
    const { userId, role } = getJwtUser(request);
    if (role !== 'admin') return reply.code(403).send({ error: 'Admin only' });

    const created = await identityService.createWorkspaceForAdmin(userId, request.body.name);
    if (!created.ok) return reply.code(created.status).send({ error: created.error });

    const token = await signSessionToken(fastify, {
      userId,
      workspaceId: created.workspace.id,
    });
    const access = await resolveMembershipAccess(userId, created.workspace.id);

    return {
      token,
      workspace: created.workspace,
      workspaces: created.workspaces,
      activeWorkspaceId: created.workspace.id,
      user: sessionUserView(created.user, access),
    };
  });

  app.patch(
    '/profile',
    { onRequest: [authenticate, requireWorkspaceAccess], schema: { body: patchProfileBodySchema } },
    async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
    try {
      const user = await updateUserProfile(userId, request.body);
      const access = await resolveMembershipAccess(userId, workspaceId);
      return { user: { ...user, role: access.role, permissions: access.permissions, inboxScope: access.inboxScope } };
    } catch (err) {
      return replyServiceError(reply, err);
    }
  });

  app.patch(
    '/avatar',
    { onRequest: [authenticate, requireWorkspaceAccess], schema: { body: patchAvatarBodySchema } },
    async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    const user = await updateUserAvatar(userId, request.body?.avatar);
    const access = await resolveMembershipAccess(userId, workspaceId);
    return { user: { ...user, role: access.role, permissions: access.permissions, inboxScope: access.inboxScope } };
  });

  app.post(
    '/change-password',
    { onRequest: [authenticate, requireWorkspaceAccess], schema: { body: changePasswordBodySchema } },
    async (request) => {
    const { userId } = getJwtUser(request);
    return changeUserPassword(userId, request.body);
  });

  app.get('/me', { onRequest: [authenticate, requireWorkspaceAccess] }, getMe);
}
