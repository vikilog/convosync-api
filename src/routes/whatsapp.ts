import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { decryptSecret } from '../lib/field-encryption.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { planGatePayload } from '../services/planUsageGuards.js';
import { connectWorkspaceWhatsApp } from '../services/whatsappConnect.js';
import { listWhatsAppAccounts } from '../services/whatsappAccounts.js';
import { getWorkspaceWhatsAppCredentials } from '../services/whatsappCredentials.js';
import {
  getWebhookSubscriptionStatus,
  subscribeWhatsAppWebhooks,
} from '../services/whatsappWebhookSubscribe.js';
import { purgeWhatsAppPhoneAccountData } from '../services/whatsappDisconnectCleanup.service.js';
import {
  getWhatsAppBusinessProfile,
  graphGetPhoneMeta,
  updateWhatsAppBusinessProfile,
  WHATSAPP_PROFILE_VERTICALS,
} from '../services/whatsappBusinessProfile.js';
import {
  acknowledgeWhatsAppPaymentSetup,
  getWhatsAppPaymentStatus,
  refreshWhatsAppPaymentConfiguration,
  setWhatsAppPaymentMode,
} from '../services/whatsappPaymentConfig.js';
import {
  whatsappBusinessProfileBodySchema,
  whatsappConnectBodySchema,
  whatsappDisconnectBodySchema,
  whatsappDisconnectQuerySchema,
  whatsappPaymentAckBodySchema,
  whatsappPaymentModeBodySchema,
  whatsappPaymentQuerySchema,
  whatsappPaymentRefreshBodySchema,
  whatsappPhoneParamsSchema,
} from './whatsapp.schemas.js';

export default async function whatsappRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  /** Signed state for Meta OAuth redirect (add redirect URI in Meta dashboard). */
  app.get('/oauth/state', auth, async (request) => {
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
  app.post(
    '/connect',
    { ...auth, schema: { body: whatsappConnectBodySchema } },
    async (request, reply) => {
    const body = request.body;
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
        businessId: body.businessId,
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
      if (result.creditLineShare?.skipped) {
        fastify.log.info(
          { creditLineShare: result.creditLineShare },
          'WhatsApp credit-line share skipped (env not configured)'
        );
      } else if (result.creditLineShare?.error) {
        fastify.log.warn(
          {
            creditLineShare: {
              shared: result.creditLineShare.shared,
              wabaId: result.creditLineShare.wabaId,
              error: result.creditLineShare.error,
            },
          },
          'WhatsApp connected but credit-line share failed — client may be asked for their own payment method'
        );
      } else if (result.creditLineShare?.shared) {
        fastify.log.info(
          {
            creditLineShare: {
              shared: true,
              alreadyShared: result.creditLineShare.alreadyShared,
              wabaId: result.creditLineShare.wabaId,
              allocationConfigId: result.creditLineShare.allocationConfigId,
            },
          },
          'WhatsApp credit line shared with client WABA'
        );
      }

      return reply.send({
        success: true,
        ...result,
      });
    } catch (err: any) {
      const gate = planGatePayload(err);
      if (gate) return reply.code(403).send(gate);

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

  app.get('/accounts', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const accounts = await listWhatsAppAccounts(workspaceId);

    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        phoneNumberId: a.phoneNumberId,
        wabaId: a.wabaId,
        phoneNumber: a.phoneNumber,
        displayName: a.displayName,
        connectionMode: a.connectionMode || 'business_api',
        paymentMode: a.paymentMode || null,
        hasOwnMetaPaymentMethod: a.hasOwnMetaPaymentMethod,
        paymentConfigCheckedAt: a.paymentConfigCheckedAt?.toISOString() ?? null,
        metaBusinessId: a.metaBusinessId || null,
        label: a.displayName || 'WhatsApp Business Account',
        status: 'Connected',
        verified: true,
      })),
    };
  });

  app.get('/status', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const [workspace, accounts] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { waNumberId: true, wabaId: true, waPhoneNumber: true, name: true, waToken: true },
      }),
      listWhatsAppAccounts(workspaceId),
    ]);

    const connected = accounts.length > 0 || !!workspace?.waNumberId;

    // Some accounts (e.g. connected before this field was backfilled) are missing their
    // display phone number/name — fetch it live from Meta once and persist it.
    const needsBackfill = accounts.filter((a) => !a.phoneNumber || !a.displayName);
    if (needsBackfill.length > 0) {
      await Promise.all(
        needsBackfill.map(async (a) => {
          try {
            const { accessToken } = await getWorkspaceWhatsAppCredentials(workspaceId, a.phoneNumberId);
            if (!accessToken) return;
            const meta = await graphGetPhoneMeta(a.phoneNumberId, accessToken);
            const displayPhoneNumber =
              typeof meta.display_phone_number === 'string' ? meta.display_phone_number : null;
            const verifiedName = typeof meta.verified_name === 'string' ? meta.verified_name : null;
            if (!displayPhoneNumber && !verifiedName) return;

            await prisma.whatsAppPhoneAccount.update({
              where: { id: a.id },
              data: {
                ...(displayPhoneNumber && !a.phoneNumber ? { phoneNumber: displayPhoneNumber } : {}),
                ...(verifiedName && !a.displayName ? { displayName: verifiedName } : {}),
              },
            });
            if (displayPhoneNumber && !a.phoneNumber) a.phoneNumber = displayPhoneNumber;
            if (verifiedName && !a.displayName) a.displayName = verifiedName;
          } catch (err) {
            request.log.warn({ err, phoneNumberId: a.phoneNumberId }, 'Could not backfill WhatsApp phone number');
          }
        })
      );
    }

    let webhookSubscription: Awaited<ReturnType<typeof getWebhookSubscriptionStatus>> | null =
      null;
    const waToken = decryptSecret(workspace?.waToken);
    if (workspace?.wabaId && waToken) {
      try {
        webhookSubscription = await getWebhookSubscriptionStatus(
          workspace.wabaId,
          waToken
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
        connectionMode: a.connectionMode || 'business_api',
        paymentMode: a.paymentMode || null,
        hasOwnMetaPaymentMethod: a.hasOwnMetaPaymentMethod,
        metaBusinessId: a.metaBusinessId || null,
      })),
      coexistenceConnected: accounts.some((a) => a.connectionMode === 'app_coexistence'),
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
        /** Solution Partner credit-line share ready (env set; does not prove Meta partner tier). */
        creditLineShareConfigured: !!(config.meta.creditLineId && config.meta.systemUserToken),
        creditLineCurrency: config.meta.creditLineId
          ? config.meta.creditLineCurrency
          : undefined,
      },
    };
  });

  /** Re-run Meta webhook subscribe for the connected WABA (e.g. after tunnel URL change). */
  app.post('/webhooks/subscribe', auth, async (request, reply) => {
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

  app.get(
    '/accounts/:phoneNumberId/business-profile',
    { ...auth, schema: { params: whatsappPhoneParamsSchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { phoneNumberId } = request.params;
    if (!phoneNumberId?.trim()) {
      return reply.code(400).send({ error: 'phoneNumberId is required' });
    }
    try {
      const data = await getWhatsAppBusinessProfile(workspaceId, phoneNumberId.trim());
      return { ...data, verticals: WHATSAPP_PROFILE_VERTICALS };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load business profile';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/accounts/:phoneNumberId/business-profile',
    { ...auth, schema: { params: whatsappPhoneParamsSchema, body: whatsappBusinessProfileBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { phoneNumberId } = request.params;
    const body = request.body;
    if (!phoneNumberId?.trim()) {
      return reply.code(400).send({ error: 'phoneNumberId is required' });
    }
    try {
      const result = await updateWhatsAppBusinessProfile(workspaceId, phoneNumberId.trim(), body);
      // Refresh local displayName snapshot when Meta verified name is available after save
      try {
        const refreshed = await getWhatsAppBusinessProfile(workspaceId, phoneNumberId.trim());
        if (refreshed.verifiedName) {
          await prisma.whatsAppPhoneAccount.updateMany({
            where: { workspaceId, phoneNumberId: phoneNumberId.trim() },
            data: { displayName: refreshed.verifiedName },
          });
        }
      } catch {
        /* non-fatal */
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update business profile';
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * GET /api/whatsapp/payment-mode
   * Stored payment mode + billingCheckStatus (confirmed|missing|unknown).
   */
  app.get(
    '/payment-mode',
    { ...auth, schema: { querystring: whatsappPaymentQuerySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query;
    try {
      const status = await getWhatsAppPaymentStatus(workspaceId, query.phoneNumberId);
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'WhatsApp not connected';
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * POST /api/whatsapp/payment-mode
   * Choose Self Pay (platform is Coming soon — rejected).
   */
  app.post(
    '/payment-mode',
    { ...auth, schema: { body: whatsappPaymentModeBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;
    if (body.paymentMode !== 'self_pay' && body.paymentMode !== 'platform') {
      return reply.code(400).send({ error: 'paymentMode must be self_pay or platform' });
    }
    try {
      const status = await setWhatsAppPaymentMode(
        workspaceId,
        body.paymentMode,
        body.phoneNumberId,
        { businessIdHint: body.businessId }
      );
      return { success: true, ...status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set payment mode';
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * POST /api/whatsapp/payment-mode/refresh
   * Re-probe Meta: owner_business_info (BM URL) + primary_funding_id (BSP-gated; #10 → unknown).
   */
  app.post(
    '/payment-mode/refresh',
    { ...auth, schema: { body: whatsappPaymentRefreshBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;
    try {
      const status = await refreshWhatsAppPaymentConfiguration(
        workspaceId,
        body.phoneNumberId,
        { businessIdHint: body.businessId }
      );
      return { success: true, ...status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to refresh payment status';
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * POST /api/whatsapp/payment-mode/acknowledge
   * User confirms they added a Meta payment method when auto-check is unknown (Tech Provider).
   */
  app.post(
    '/payment-mode/acknowledge',
    { ...auth, schema: { body: whatsappPaymentAckBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;
    try {
      const status = await acknowledgeWhatsAppPaymentSetup(workspaceId, body.phoneNumberId);
      return { success: true, ...status };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to acknowledge payment setup';
      return reply.code(400).send({ error: message });
    }
  });

  app.delete(
    '/disconnect',
    {
      ...auth,
      schema: { querystring: whatsappDisconnectQuerySchema, body: whatsappDisconnectBodySchema },
    },
    async (request) => {
    const { workspaceId } = getJwtUser(request);
    const query = request.query;
    const body = request.body;
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
