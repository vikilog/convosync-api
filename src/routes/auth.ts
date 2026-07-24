import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../index.js';
import { authenticate, getJwtUser } from '../middleware/auth.js';
import { requireWorkspaceAccess } from '../middleware/workspaceScope.js';
import {
  ensureUserMemberships,
  listUserWorkspaces,
  userHasWorkspaceAccess,
} from '../services/workspaceMembership.js';
import { resolveMembershipAccess } from '../services/workspaceMemberAdmin.js';
import {
  changeUserPassword,
  sanitizeUser,
  updateUserAvatar,
  updateUserProfile,
} from '../services/userProfile.js';
import { onboardingPayloadFromUser } from '../services/onboarding.js';
import { newCustomerTrialFields } from '../services/trial.js';
import { grantSignupWalletCredit } from '../services/wallet.service.js';
import {
  blacklistJti,
  bumpTokenVersion,
  ensureUserSecurityState,
  JtiBlacklistUnavailableError,
  signSessionToken,
} from '../services/userSecurity.js';

export default async function authRoutes(fastify: FastifyInstance) {

  fastify.get('/test', async (request, reply) => {
    const start = new Date();
    const user = await prisma.user.findUnique({ where: { email: 'support@convosync.io' } });
    const end = new Date();
    console.log('time', end.getTime() - start.getTime());
    return { user, timeMs: end.getTime() - start.getTime() };
  });

  fastify.post('/register', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(8),
      workspaceName: z.string().min(2).optional(),
    });
    const body = schema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) return reply.code(409).send({ error: 'Email already registered' });

    const placeholderWorkspaceName = body.workspaceName?.trim() || `${body.name.trim()}'s Workspace`;
    const slug = placeholderWorkspaceName.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
    const workspace = await prisma.workspace.create({
      data: {
        name: placeholderWorkspaceName,
        slug,
        email: body.email,
        ...newCustomerTrialFields(),
      },
    });

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        password: await bcrypt.hash(body.password, 12),
        role: 'admin',
        workspaceId: workspace.id,
        onboardingStep: 1,
        onboardingCompleted: false,
        onboardingSkippedSteps: [],
        memberships: {
          create: { workspaceId: workspace.id, role: 'admin' },
        },
        securityState: {
          create: { tokenVersion: 0, updatedReason: 'signup' },
        },
      },
    });

    await grantSignupWalletCredit(workspace.id);

    const workspaces = await listUserWorkspaces(user.id);
    const token = await signSessionToken(fastify, {
      userId: user.id,
      workspaceId: workspace.id,
    });
    const access = await resolveMembershipAccess(user.id, workspace.id);

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: access.role,
        permissions: access.permissions,
        inboxScope: access.inboxScope,
        ...onboardingPayloadFromUser(user),
      },
      workspace,
      workspaces,
      activeWorkspaceId: workspace.id,
    };
  });

  fastify.post('/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string(),
      workspaceId: z.string().optional(),
    });
    const body = schema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { workspace: true },
    });
    if (!user || !(await bcrypt.compare(body.password, user.password))) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    await ensureUserSecurityState(user.id);

    const workspaces = await listUserWorkspaces(user.id);
    let activeWorkspaceId = user.workspaceId;

    if (body.workspaceId) {
      const allowed = await userHasWorkspaceAccess(user.id, body.workspaceId);
      if (!allowed) return reply.code(403).send({ error: 'No access to this company' });
      activeWorkspaceId = body.workspaceId;
    }

    const activeWorkspace =
      workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
    if (activeWorkspace) activeWorkspaceId = activeWorkspace.id;

    const token = await signSessionToken(fastify, {
      userId: user.id,
      workspaceId: activeWorkspaceId,
    });
    const access = await resolveMembershipAccess(user.id, activeWorkspaceId);

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: access.role,
        permissions: access.permissions,
        inboxScope: access.inboxScope,
        ...onboardingPayloadFromUser(user),
      },
      workspace: activeWorkspace ?? user.workspace,
      workspaces,
      activeWorkspaceId,
    };
  });

  /** Logout this device — blacklist jti until JWT exp (Redis). */
  fastify.post('/logout', { onRequest: [authenticate] }, async (request, reply) => {
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
  fastify.post(
    '/logout-all',
    { onRequest: [authenticate, requireWorkspaceAccess] },
    async (request) => {
      const { userId } = getJwtUser(request);
      if (!userId) return { success: false };
      const tokenVersion = await bumpTokenVersion(userId, 'logout_all');
      return { success: true, tokenVersion };
    }
  );

  fastify.get('/workspaces', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    const workspaces = await listUserWorkspaces(userId!);
    const active = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
    return { workspaces, activeWorkspaceId: active?.id ?? workspaceId };
  });

  fastify.post('/switch-workspace', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request, reply) => {
    const { userId } = getJwtUser(request);
    const body = z.object({ workspaceId: z.string().min(1) }).parse(request.body);

    const allowed = await userHasWorkspaceAccess(userId!, body.workspaceId);
    if (!allowed) return reply.code(403).send({ error: 'No access to this company' });

    const user = await prisma.user.findUnique({ where: { id: userId! } });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const workspace = await prisma.workspace.findUnique({ where: { id: body.workspaceId } });
    if (!workspace) return reply.code(404).send({ error: 'Company not found' });

    const token = await signSessionToken(fastify, {
      userId: userId!,
      workspaceId: workspace.id,
    });
    const workspaces = await listUserWorkspaces(userId!);
    const access = await resolveMembershipAccess(userId!, workspace.id);

    return {
      token,
      workspace,
      workspaces,
      activeWorkspaceId: workspace.id,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: access.role,
        permissions: access.permissions,
        inboxScope: access.inboxScope,
      },
    };
  });

  fastify.post('/workspaces', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request, reply) => {
    const { userId, role } = getJwtUser(request);
    if (role !== 'admin') return reply.code(403).send({ error: 'Admin only' });

    const body = z.object({ name: z.string().min(2) }).parse(request.body);
    const slug = body.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();

    const workspace = await prisma.workspace.create({
      data: {
        name: body.name,
        slug,
        ...newCustomerTrialFields(),
      },
    });

    await prisma.workspaceMembership.create({
      data: { userId: userId!, workspaceId: workspace.id, role: 'admin' },
    });

    await grantSignupWalletCredit(workspace.id);

    const workspaces = await listUserWorkspaces(userId!);
    const user = await prisma.user.findUnique({ where: { id: userId! } });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const token = await signSessionToken(fastify, {
      userId: userId!,
      workspaceId: workspace.id,
    });
    const access = await resolveMembershipAccess(userId!, workspace.id);

    return {
      token,
      workspace,
      workspaces,
      activeWorkspaceId: workspace.id,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: access.role,
        permissions: access.permissions,
        inboxScope: access.inboxScope,
      },
    };
  });

  fastify.patch('/profile', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    const body = z.object({ name: z.string().min(2).max(120) }).parse(request.body);
    const user = await updateUserProfile(userId!, { name: body.name });
    const access = await resolveMembershipAccess(userId!, workspaceId!);
    return {
      user: {
        ...user,
        role: access.role,
        permissions: access.permissions,
        inboxScope: access.inboxScope,
      },
    };
  });

  fastify.patch('/avatar', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    const body = z
      .object({ avatar: z.string().nullable().optional() })
      .parse(request.body ?? {});
    const user = await updateUserAvatar(userId!, body.avatar);
    const access = await resolveMembershipAccess(userId!, workspaceId!);
    return {
      user: {
        ...user,
        role: access.role,
        permissions: access.permissions,
        inboxScope: access.inboxScope,
      },
    };
  });

  fastify.post('/change-password', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request) => {
    const { userId } = getJwtUser(request);
    const body = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8),
      })
      .parse(request.body);
    return changeUserPassword(userId!, body);
  });

  fastify.get('/me', { onRequest: [authenticate, requireWorkspaceAccess] }, async (request, reply) => {
    const { userId, workspaceId } = getJwtUser(request);
  
    await ensureUserMemberships(userId!); // must stay first if it writes memberships
  
    // Run independent reads in parallel instead of sequentially
    const [user, workspaces] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId! },
        include: {
          workspace: true,
          memberships: { include: { workspace: true } },
        },
      }),
      listUserWorkspaces(userId!),
    ]);
  
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }
  
    const activeWorkspace =
      workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? user.workspace;
  
    const access = await resolveMembershipAccess(userId!, activeWorkspace?.id ?? workspaceId!);

    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const safeUser = sanitizeUser(user);

    return {
      ...safeUser,
      role: access.role,
      permissions: access.permissions,
      inboxScope: access.inboxScope,
      workspaces,
      activeWorkspaceId: activeWorkspace?.id ?? workspaceId,
      activeWorkspace,
      ...onboardingPayloadFromUser(user),
    };
  });
}
