import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import axios from 'axios';
import { prisma } from '../index.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  connectWorkspaceMetaAds,
  createCTWACampaign,
  fetchMetaAdCampaigns,
  getConnectedMetaAdsAccount,
  listWorkspaceMetaAdAccounts,
  resolveMetaAdsRedirectUri,
  selectWorkspaceMetaAdAccount,
  setCampaignStatus,
} from '../services/metaAdsConnect.js';
import { assertPlanFeature, PlanGateError } from '../services/planUsageGuards.js';
import {
  metaAdsCampaignParamsSchema,
  metaAdsConnectBodySchema,
  metaAdsCtwaCreateBodySchema,
  metaAdsSelectAccountBodySchema,
} from './metaAds.schemas.js';

export default async function metaAdsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  app.get('/oauth/state', auth, async (request) => {
    const user = getJwtUser(request);
    const state = fastify.jwt.sign(
      {
        userId: user.userId,
        workspaceId: user.workspaceId,
        role: user.role,
        purpose: 'meta_ads_oauth',
      },
      { expiresIn: '15m' }
    );

    const redirectUri = resolveMetaAdsRedirectUri();

    return {
      state,
      redirectUri,
      oauthRedirectUri: redirectUri,
      suggestedRedirectUris: [redirectUri],
      note:
        'Add redirectUri in Meta App → Facebook Login → Valid OAuth Redirect URIs. Enable ads_read, ads_management, business_management.',
    };
  });

  app.get('/account', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const result = await getConnectedMetaAdsAccount(workspaceId);
    if (!result.connected) return { connected: false };
    return { connected: true, account: result.account };
  });

  app.get('/accounts', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    try {
      const accounts = await listWorkspaceMetaAdAccounts(workspaceId);
      return { accounts };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to list ad accounts';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/account/select',
    { ...auth, schema: { body: metaAdsSelectAccountBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;

    if (!body.adAccountId) {
      return reply.code(400).send({ error: 'Missing adAccountId' });
    }

    try {
      const result = await selectWorkspaceMetaAdAccount(workspaceId, body.adAccountId);
      return reply.send({ success: true, ...result });
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : 'Failed to select ad account';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/connect',
    { ...auth, schema: { body: metaAdsConnectBodySchema } },
    async (request, reply) => {
    const body = request.body;
    const { workspaceId } = getJwtUser(request);

    if (!body.code) {
      return reply.code(400).send({ error: 'Missing Meta authorization code' });
    }

    try {
      const result = await connectWorkspaceMetaAds({
        workspaceId,
        code: body.code,
        redirectUri: body.redirectUri,
        adAccountId: body.adAccountId,
      });

      fastify.log.info(
        `Meta Ads connected for workspace ${workspaceId}: ${result.adAccountName} (${result.adAccountId})`
      );

      return reply.send({ success: true, ...result });
    } catch (err: unknown) {
      const graphMessage =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : 'Meta Ads connection failed';
      return reply.code(400).send({ error: graphMessage });
    }
  });

  app.delete('/disconnect', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { metaAdAccountId: null, metaUserToken: null },
    });
    return { success: true };
  });

  app.get('/campaigns', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    try {
      const campaigns = await fetchMetaAdCampaigns(workspaceId);
      return { campaigns };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch campaigns';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/campaigns/:id/pause',
    { ...auth, schema: { params: metaAdsCampaignParamsSchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params;

    try {
      await setCampaignStatus(workspaceId, id, 'PAUSED');
      return { success: true };
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : 'Failed to pause campaign';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/campaigns/:id/resume',
    { ...auth, schema: { params: metaAdsCampaignParamsSchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params;

    try {
      await setCampaignStatus(workspaceId, id, 'ACTIVE');
      return { success: true };
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : 'Failed to resume campaign';
      return reply.code(400).send({ error: message });
    }
  });

  app.delete(
    '/campaigns/:id',
    { ...auth, schema: { params: metaAdsCampaignParamsSchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params;

    try {
      await setCampaignStatus(workspaceId, id, 'DELETED');
      return { success: true };
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : 'Failed to delete campaign';
      return reply.code(400).send({ error: message });
    }
  });

  app.post(
    '/ctwa/create',
    { ...auth, schema: { body: metaAdsCtwaCreateBodySchema } },
    async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body;

    if (!body.campaignName || !body.dailyBudget || !body.startDate || !body.headline) {
      return reply.code(400).send({ error: 'Missing required CTWA ad fields' });
    }

    try {
      await assertPlanFeature(workspaceId, 'ctwaAds');
      const result = await createCTWACampaign(workspaceId, {
        campaignName: body.campaignName,
        dailyBudget: body.dailyBudget,
        startDate: body.startDate,
        endDate: body.endDate,
        headline: body.headline,
        description: body.description || '',
        targeting: {
          ageMin: body.targeting?.ageMin ?? 18,
          ageMax: body.targeting?.ageMax ?? 45,
          locations: body.targeting?.locations ?? ['IN'],
        },
      });
      return reply.send({ success: true, ...result });
    } catch (err: unknown) {
      if (err instanceof PlanGateError) {
        return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
      }
      const message =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : 'Failed to create CTWA ad';
      return reply.code(400).send({ error: message });
    }
  });
}
