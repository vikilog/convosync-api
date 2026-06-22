import { FastifyInstance } from 'fastify';
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

export default async function metaAdsRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/oauth/state', auth, async (request) => {
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

  fastify.get('/account', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const result = await getConnectedMetaAdsAccount(workspaceId);
    if (!result.connected) return { connected: false };
    return { connected: true, account: result.account };
  });

  fastify.get('/accounts', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    try {
      const accounts = await listWorkspaceMetaAdAccounts(workspaceId);
      return { accounts };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to list ad accounts';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/account/select', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body as { adAccountId?: string };

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

  fastify.post('/connect', auth, async (request, reply) => {
    const body = request.body as { code?: string; redirectUri?: string; adAccountId?: string };
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

  fastify.delete('/disconnect', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { metaAdAccountId: null, metaUserToken: null },
    });
    return { success: true };
  });

  fastify.get('/campaigns', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);

    try {
      const campaigns = await fetchMetaAdCampaigns(workspaceId);
      return { campaigns };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch campaigns';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/campaigns/:id/pause', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

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

  fastify.post('/campaigns/:id/resume', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

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

  fastify.delete('/campaigns/:id', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };

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

  fastify.post('/ctwa/create', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = request.body as {
      campaignName?: string;
      dailyBudget?: number;
      startDate?: string;
      endDate?: string;
      headline?: string;
      description?: string;
      targeting?: { ageMin?: number; ageMax?: number; locations?: string[] };
    };

    if (!body.campaignName || !body.dailyBudget || !body.startDate || !body.headline) {
      return reply.code(400).send({ error: 'Missing required CTWA ad fields' });
    }

    try {
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
