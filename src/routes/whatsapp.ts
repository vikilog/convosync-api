import { FastifyInstance } from 'fastify';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { connectWorkspaceWhatsApp } from '../services/whatsappConnect.js';
import { listWhatsAppAccounts } from '../services/whatsappAccounts.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';
import {
  getWebhookSubscriptionStatus,
  subscribeWhatsAppWebhooks,
} from '../services/whatsappWebhookSubscribe.js';
import { purgeWhatsAppPhoneAccountData } from '../services/whatsappDisconnectCleanup.service.js';

export default async function whatsappRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  /** Signed state for Meta OAuth redirect (add redirect URI in Meta dashboard). */
  fastify.get('/oauth/state', auth, async (request) => {
    const user = getJwtUser(request);
    const state = fastify.jwt.sign(
      {
        userId: user.userId,
        workspaceId: user.workspaceId,
        role: user.role,
        purpose: 'whatsapp_oauth',
      },
      { expiresIn: '15m' }
    );
    return {
      state,
      redirectUri: config.meta.embeddedRedirectUri,
      oauthRedirectUri: config.meta.oauthRedirectUri,
      backendCallbackUri: config.meta.oauthBackendCallbackUri,
      whatsappConfigId: config.meta.whatsappConfigId || undefined,
    };
  });

  /**
   * Meta OAuth redirect target (server-side).
   * Add in Meta: Valid OAuth Redirect URIs → http://localhost:4000/api/whatsapp/oauth/callback
   */
  fastify.get('/oauth/callback', async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    const failRedirect = (message: string) => {
      const url = new URL(`${config.frontendUrl}/whatsapp/callback`);
      url.searchParams.set('error', message);
      return reply.redirect(url.toString());
    };

    if (query.error) {
      return failRedirect(query.error_description || query.error);
    }

    if (!query.code || !query.state) {
      return failRedirect('Missing authorization code from Meta');
    }

    try {
      const payload = fastify.jwt.verify<{ purpose?: string; workspaceId: string }>(query.state);
      if (payload.purpose !== 'whatsapp_oauth' || !payload.workspaceId) {
        return failRedirect('Invalid OAuth state');
      }

      const result = await connectWorkspaceWhatsApp({
        workspaceId: payload.workspaceId,
        code: query.code,
        redirectUri: config.meta.oauthRedirectUri,
      });

      fastify.log.info(
        `WhatsApp OAuth callback connected workspace ${payload.workspaceId}: ${result.phoneNumber}`
      );

      const successUrl = new URL(`${config.frontendUrl}/whatsapp/callback`);
      successUrl.searchParams.set('success', '1');
      successUrl.searchParams.set('phone', result.phoneNumber);
      return reply.redirect(successUrl.toString());
    } catch (err: any) {
      fastify.log.error(err?.response?.data || err.message, 'WhatsApp OAuth callback error');
      const message =
        err?.response?.data?.error?.message || err?.message || 'WhatsApp connection failed';
      return failRedirect(message);
    }
  });

  /**
   * POST /api/whatsapp/connect
   * After Embedded Signup: code from FB.login + optional IDs from WA_EMBEDDED_SIGNUP postMessage
   */
  fastify.post('/connect', auth, async (request, reply) => {
    const body = request.body as {
      code?: string;
      redirectUri?: string;
      wabaId?: string;
      phoneNumberId?: string;
      phoneNumber?: string;
      displayName?: string;
      connectionMode?: 'business_api' | 'app_coexistence';
    };
    const { workspaceId } = getJwtUser(request);

    if (!body.code) {
      return reply.code(400).send({ error: 'Missing Meta authorization code' });
    }

    try {
      const result = await connectWorkspaceWhatsApp({
        workspaceId,
        code: body.code,
        redirectUri: body.redirectUri,
        wabaId: body.wabaId,
        phoneNumberId: body.phoneNumberId,
        phoneNumber: body.phoneNumber,
        displayName: body.displayName,
        connectionMode: body.connectionMode,
      });

      fastify.log.info(`WhatsApp connected for workspace ${workspaceId}: ${result.phoneNumber}`);
      if (result.webhookSubscribe?.error) {
        fastify.log.warn(
          { webhookSubscribe: result.webhookSubscribe },
          'WhatsApp connected but webhook auto-subscribe had issues'
        );
      } else if (result.webhookSubscribe?.wabaSubscribed) {
        fastify.log.info(
          { webhookSubscribe: result.webhookSubscribe },
          'WhatsApp webhooks auto-subscribed for WABA'
        );
      }

      return reply.send({
        success: true,
        ...result,
      });
    } catch (err: any) {
      fastify.log.error(err?.response?.data || err.message, 'WhatsApp connect error');
      return reply.code(500).send({
        error: 'WhatsApp connection failed',
        details: err?.response?.data?.error?.message || err.message,
      });
    }
  });

  /**
   * POST /api/whatsapp/connect-oauth
   * Frontend callback page: code + state from Meta redirect to /whatsapp/callback
   */
  fastify.post('/connect-oauth', async (request, reply) => {
    const body = request.body as { code?: string; state?: string };

    if (!body.code || !body.state) {
      return reply.code(400).send({ error: 'Missing code or state' });
    }

    try {
      const payload = fastify.jwt.verify<{ purpose?: string; workspaceId: string }>(body.state);
      if (payload.purpose !== 'whatsapp_oauth' || !payload.workspaceId) {
        return reply.code(400).send({ error: 'Invalid OAuth state' });
      }

      const result = await connectWorkspaceWhatsApp({
        workspaceId: payload.workspaceId,
        code: body.code,
        redirectUri: config.meta.oauthRedirectUri,
      });

      return reply.send({ success: true, ...result });
    } catch (err: any) {
      fastify.log.error(err?.response?.data || err.message, 'WhatsApp connect-oauth error');
      return reply.code(500).send({
        error: 'WhatsApp connection failed',
        details: err?.response?.data?.error?.message || err.message,
      });
    }
  });

  fastify.get('/accounts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const accounts = await listWhatsAppAccounts(workspaceId);

    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        phoneNumberId: a.phoneNumberId,
        wabaId: a.wabaId,
        phoneNumber: a.phoneNumber,
        displayName: a.displayName,
        label: a.displayName || 'WhatsApp Business Account',
        status: 'Connected',
        verified: true,
      })),
    };
  });

  fastify.get('/status', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const [workspace, accounts] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { waNumberId: true, wabaId: true, waPhoneNumber: true, name: true, waToken: true },
      }),
      listWhatsAppAccounts(workspaceId),
    ]);

    const connected = accounts.length > 0 || !!workspace?.waNumberId;

    let webhookSubscription: Awaited<ReturnType<typeof getWebhookSubscriptionStatus>> | null =
      null;
    if (workspace?.wabaId && workspace.waToken) {
      try {
        webhookSubscription = await getWebhookSubscriptionStatus(
          workspace.wabaId,
          workspace.waToken
        );
      } catch (err) {
        request.log.warn({ err }, 'Could not load WABA webhook subscription status');
      }
    }

    return {
      connected,
      phoneNumber: workspace?.waPhoneNumber,
      phoneNumberId: workspace?.waNumberId,
      wabaId: workspace?.wabaId,
      accounts: accounts.map((a) => ({
        id: a.id,
        phoneNumberId: a.phoneNumberId,
        phoneNumber: a.phoneNumber,
        displayName: a.displayName,
        wabaId: a.wabaId,
      })),
      redirectUri: config.meta.embeddedRedirectUri,
      oauthRedirectUri: config.meta.oauthRedirectUri,
      backendCallbackUri: config.meta.oauthBackendCallbackUri,
      whatsappConfigId: config.meta.whatsappConfigId || undefined,
      webhookUrl: config.webhookUrl,
      webhookVerifyToken: config.meta.webhookVerifyToken,
      webhookSubscription,
      webhookAutoSubscribe: true,
      embeddedSignupVersion: 'v3',
      signup: {
        appIdConfigured: !!config.meta.appId,
        businessApiConfigConfigured: !!config.meta.configId,
        coexistenceConfigConfigured: !!config.meta.whatsappConfigId,
        coexistenceConfigSuffix: config.meta.whatsappConfigId
          ? config.meta.whatsappConfigId.slice(-6)
          : undefined,
        businessApiConfigSuffix: config.meta.configId
          ? config.meta.configId.slice(-6)
          : undefined,
      },
    };
  });

  /** Re-run Meta webhook subscribe for the connected WABA (e.g. after tunnel URL change). */
  fastify.post('/webhooks/subscribe', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    try {
      const { wabaId, accessToken } = await getWorkspaceWhatsAppCredentials(workspaceId);
      const result = await subscribeWhatsAppWebhooks(wabaId, accessToken);

      if (!result.wabaSubscribed && result.error) {
        return reply.code(502).send({
          error: 'Webhook subscription failed',
          details: result.error,
          webhookSubscribe: result,
        });
      }

      let webhookSubscription: Awaited<ReturnType<typeof getWebhookSubscriptionStatus>> | null =
        null;
      try {
        webhookSubscription = await getWebhookSubscriptionStatus(wabaId, accessToken);
      } catch {
        /* non-fatal */
      }

      return {
        success: true,
        webhookSubscribe: result,
        webhookSubscription,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'WhatsApp not connected';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.delete('/disconnect', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query as { phoneNumberId?: string };
    const body = (request.body || {}) as { phoneNumberId?: string };
    const phoneNumberId = query.phoneNumberId || body.phoneNumberId;

    const cleanup = await purgeWhatsAppPhoneAccountData(workspaceId, {
      phoneNumberId,
      removeAllWhatsAppAccounts: !phoneNumberId,
    });

    if (phoneNumberId) {
      await prisma.whatsAppPhoneAccount.deleteMany({
        where: { workspaceId, phoneNumberId },
      });

      const remaining = await prisma.whatsAppPhoneAccount.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      if (remaining.length > 0) {
        const primary = remaining[0];
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: {
            waNumberId: primary.phoneNumberId,
            wabaId: primary.wabaId,
            waPhoneNumber: primary.phoneNumber,
          },
        });
      } else {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { waNumberId: null, waToken: null, wabaId: null, waPhoneNumber: null },
        });
      }

      request.log.info({ workspaceId, phoneNumberId, cleanup }, 'WhatsApp number disconnected');
      return { success: true, cleanup };
    }

    await prisma.whatsAppPhoneAccount.deleteMany({ where: { workspaceId } });
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { waNumberId: null, waToken: null, wabaId: null, waPhoneNumber: null },
    });

    request.log.info({ workspaceId, cleanup }, 'All WhatsApp numbers disconnected');
    return { success: true, cleanup };
  });
}
