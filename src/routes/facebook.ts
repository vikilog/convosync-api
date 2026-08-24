import { FastifyInstance } from 'fastify';
import axios from 'axios';
import { prisma } from '../index.js';
import { encryptSecret } from '../lib/field-encryption.js';
import { getJwtUser, type JwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';
import { getWorkspaceFacebookPageCredentials } from '../services/facebookCredentials.js';
import { subscribeFacebookPageFeed } from '../services/instagramWebhookSubscribe.js';
import { upsertListeningCommentsForPost, triggerClassifyAfterUpsert } from '../services/socialCommentSync.service.js';
import {
  connectWorkspaceFacebook,
  previewFacebookConnect,
  completeFacebookConnect,
  FacebookConnectError,
  getConnectedFacebookPage,
  inspectPageAccessToken,
  fetchFacebookPagePosts,
  fetchFacebookPageInsights,
  resolveFacebookRedirectUri,
  type FacebookPageSessionCandidate,
} from '../services/facebookConnect.js';

const GRAPH_API = 'https://graph.facebook.com/v19.0';

type GraphPost = {
  id: string;
  message?: string;
  full_picture?: string;
  created_time?: string;
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
  permalink_url?: string;
};

type InsightMetric = {
  name: string;
  values?: Array<{ value: number | Record<string, number>; end_time?: string }>;
};

function numericValue(val: number | Record<string, number> | undefined): number {
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object') {
    return Object.values(val).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  }
  return 0;
}

function metricDailyValues(metric?: InsightMetric): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of metric?.values || []) {
    if (!entry.end_time) continue;
    const dateKey = new Date(entry.end_time).toISOString().slice(0, 10);
    map.set(dateKey, numericValue(entry.value));
  }
  return map;
}

function formatDayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function pickDailyMetric(byName: Map<string, InsightMetric>, ...names: string[]): Map<string, number> {
  for (const name of names) {
    const values = metricDailyValues(byName.get(name));
    if (values.size > 0) return values;
  }
  return new Map();
}

function buildDailySeries(data: { data?: InsightMetric[] }) {
  const metrics = data.data || [];
  const byName = new Map(metrics.map((m) => [m.name, m]));

  const reachMap = pickDailyMetric(byName, 'page_media_view', 'page_impressions');
  const engagedMap = pickDailyMetric(
    byName,
    'page_total_media_view_unique',
    'page_engaged_users'
  );
  const engagementMap = pickDailyMetric(byName, 'page_post_engagements');
  const viewsMap = pickDailyMetric(byName, 'page_views_total');
  const followersMap = pickDailyMetric(byName, 'page_daily_follows');

  const dateSet = new Set<string>();
  for (const map of [reachMap, engagedMap, engagementMap, viewsMap, followersMap]) {
    for (const key of map.keys()) dateSet.add(key);
  }

  return [...dateSet]
    .sort()
    .map((date) => ({
      date,
      label: formatDayLabel(date),
      reach: reachMap.get(date) ?? 0,
      engagedUsers: engagedMap.get(date) ?? 0,
      postEngagements: engagementMap.get(date) ?? 0,
      pageViews: viewsMap.get(date) ?? 0,
      newFollowers: followersMap.get(date) ?? 0,
    }));
}

function sumMetricValues(metric?: InsightMetric): number {
  if (!metric?.values?.length) return 0;
  return metric.values.reduce((sum, entry) => {
    const val = entry.value;
    if (typeof val === 'number') return sum + val;
    if (val && typeof val === 'object') {
      return sum + Object.values(val).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    }
    return sum;
  }, 0);
}

function latestMetricValue(metric?: InsightMetric): number {
  const values = metric?.values;
  if (!values?.length) return 0;
  const last = values[values.length - 1]?.value;
  if (typeof last === 'number') return last;
  if (last && typeof last === 'object') {
    return Object.values(last).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  }
  return 0;
}

function fansDelta(metric?: InsightMetric): number {
  const values = metric?.values;
  if (!values || values.length < 2) return 0;
  const prev = values[values.length - 2]?.value;
  const curr = values[values.length - 1]?.value;
  if (typeof prev === 'number' && typeof curr === 'number') return Math.max(0, curr - prev);
  return 0;
}

function normalizePosts(data: { data?: GraphPost[] }) {
  return (data.data || []).map((post) => ({
    id: post.id,
    message: post.message || '',
    fullPicture: post.full_picture,
    createdTime: post.created_time || new Date().toISOString(),
    likesCount: post.likes?.summary?.total_count ?? 0,
    commentsCount: post.comments?.summary?.total_count ?? 0,
    sharesCount: post.shares?.count ?? 0,
    permalink: post.permalink_url || `https://facebook.com/${post.id}`,
  }));
}

function normalizeInsights(data: { data?: InsightMetric[] }) {
  const metrics = data.data || [];
  const byName = new Map(metrics.map((m) => [m.name, m]));

  const pageFans =
    latestMetricValue(byName.get('page_follows')) ||
    latestMetricValue(byName.get('page_fans'));
  const pageImpressions =
    sumMetricValues(byName.get('page_media_view')) ||
    sumMetricValues(byName.get('page_impressions'));
  const pageEngagedUsers =
    sumMetricValues(byName.get('page_total_media_view_unique')) ||
    sumMetricValues(byName.get('page_engaged_users'));
  const pagePostEngagements = sumMetricValues(byName.get('page_post_engagements'));
  const pageViews = sumMetricValues(byName.get('page_views_total'));

  const dailyFollows = sumMetricValues(byName.get('page_daily_follows'));
  const pageFansDelta =
    dailyFollows ||
    fansDelta(byName.get('page_follows')) ||
    fansDelta(byName.get('page_fans'));

  return {
    pageFans,
    pageFansDelta,
    pageImpressions,
    pageEngagedUsers,
    pagePostEngagements,
    pageViews,
  };
}

function permissionHint(missingScopes: string[]): string {
  if (missingScopes.length === 0) return '';
  return ` Reconnect the Page and grant: ${missingScopes.join(', ')}. Enable them in Meta App Dashboard → App Review → Permissions and Features.`;
}

async function fetchPageInsights(pageId: string, accessToken: string, followersFallback = 0) {
  const raw = await fetchFacebookPageInsights(pageId, accessToken);
  const insights = normalizeInsights(raw);
  if (insights.pageFans === 0 && followersFallback > 0) {
    insights.pageFans = followersFallback;
  }
  const daily = buildDailySeries(raw);
  return { insights, daily };
}

async function getWorkspacePageToken(workspaceId: string) {
  const creds = await getWorkspaceFacebookPageCredentials(workspaceId);
  if (!creds) return null;
  return {
    fbPageId: creds.pageId,
    fbPageToken: creds.pageAccessToken,
    fbPageName: creds.pageName,
  };
}

export default async function facebookRoutes(fastify: FastifyInstance) {
  const auth = companyAuth;

  fastify.get('/oauth/state', auth, async (request) => {
    const user = getJwtUser(request);
    const state = fastify.jwt.sign(
      {
        userId: user.userId,
        workspaceId: user.workspaceId,
        role: user.role,
        purpose: 'facebook_oauth',
      },
      { expiresIn: '15m' }
    );

    const redirectUri = resolveFacebookRedirectUri();

    return {
      state,
      redirectUri,
      oauthRedirectUri: redirectUri,
      suggestedRedirectUris: [redirectUri],
      note: 'Add redirectUri in Meta App → Facebook Login → Valid OAuth Redirect URIs.',
    };
  });

  fastify.get('/pages', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const page = await getConnectedFacebookPage(workspaceId);
    if (!page.connected) {
      return { connected: false };
    }
    return {
      connected: true,
      page: {
        id: page.id,
        name: page.name,
        category: page.category,
        picture: page.picture,
        followersCount: page.followersCount,
        isConnected: true,
      },
      grantedScopes: page.grantedScopes,
      missingScopes: page.missingScopes,
      tokenValid: page.tokenValid,
    };
  });

  fastify.get('/token-info', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const workspace = await getWorkspacePageToken(workspaceId);
    if (!workspace?.fbPageToken) {
      return reply.code(400).send({ error: 'Page not connected' });
    }
    const info = await inspectPageAccessToken(workspace.fbPageToken);
    return info;
  });

  /** Exchanges the OAuth code and lists every Page the user manages so the frontend can show a picker instead of silently connecting the first one. */
  fastify.post('/connect/preview', auth, async (request, reply) => {
    const body = request.body as { code?: string; redirectUri?: string };
    const { workspaceId } = getJwtUser(request);

    if (!body.code) {
      return reply.code(400).send({ error: 'Missing Meta authorization code' });
    }

    try {
      const { sessionPages, requiresSelection, pages } = await previewFacebookConnect({
        workspaceId,
        code: body.code,
        redirectUri: body.redirectUri,
      });

      const connectToken = fastify.jwt.sign(
        { purpose: 'facebook_connect', workspaceId, pages: sessionPages } as JwtUser & {
          pages: unknown;
        },
        { expiresIn: '15m' }
      );

      return reply.send({ success: true, connectToken, requiresSelection, pages });
    } catch (err: unknown) {
      if (err instanceof FacebookConnectError) {
        return reply.code(400).send({
          error: err.message,
          missingScopes: err.missingScopes,
          discovery: { pagesFound: err.pagesFound, pageNames: err.pageNames },
        });
      }
      const graphMessage =
        axios.isAxiosError(err) && err.response?.data
          ? JSON.stringify(err.response.data)
          : err instanceof Error
            ? err.message
            : 'Facebook connection failed';
      return reply.code(400).send({ error: graphMessage });
    }
  });

  fastify.post('/connect', auth, async (request, reply) => {
    const body = request.body as {
      code?: string;
      redirectUri?: string;
      pageId?: string;
      pageAccessToken?: string;
      pageName?: string;
      connectToken?: string;
    };
    const { workspaceId } = getJwtUser(request);

    if (body.connectToken) {
      if (!body.pageId) {
        return reply.code(400).send({ error: 'Missing pageId for Facebook connect' });
      }

      try {
        const session = fastify.jwt.verify<{
          purpose?: string;
          workspaceId?: string;
          pages?: FacebookPageSessionCandidate[];
        }>(body.connectToken);

        if (session.purpose !== 'facebook_connect' || session.workspaceId !== workspaceId) {
          return reply.code(400).send({ error: 'Invalid or expired Facebook connect session' });
        }
        if (!session.pages?.length) {
          return reply.code(400).send({ error: 'Facebook connect session has no Pages' });
        }

        const result = await completeFacebookConnect({
          workspaceId,
          pageId: body.pageId,
          pages: session.pages,
        });

        fastify.log.info(
          `Facebook Page connected for workspace ${workspaceId}: ${result.pageName} (${result.pageId})`
        );

        const fbCredentials = await getWorkspaceFacebookPageCredentials(workspaceId);
        const webhookSubscribe = fbCredentials
          ? await subscribeFacebookPageFeed(fbCredentials.pageId, fbCredentials.pageAccessToken)
          : { ok: false, error: 'Page credentials not found after connect' };
        if (!webhookSubscribe.ok) {
          fastify.log.warn(
            { err: webhookSubscribe.error },
            `Facebook Page feed webhook subscription failed for workspace ${workspaceId}`
          );
        }

        return reply.send({ success: true, ...result, webhookSubscribe });
      } catch (err: unknown) {
        if (err instanceof FacebookConnectError) {
          return reply.code(400).send({
            error: err.message,
            missingScopes: err.missingScopes,
            discovery: { pagesFound: err.pagesFound, pageNames: err.pageNames },
          });
        }
        const message = err instanceof Error ? err.message : 'Facebook connection failed';
        return reply.code(400).send({ error: message });
      }
    }

    if (body.code) {
      try {
        const result = await connectWorkspaceFacebook({
          workspaceId,
          code: body.code,
          redirectUri: body.redirectUri,
          pageId: body.pageId,
        });

        fastify.log.info(
          `Facebook Page connected for workspace ${workspaceId}: ${result.pageName} (${result.pageId})`
        );

        const fbCredentials = await getWorkspaceFacebookPageCredentials(workspaceId);
        const webhookSubscribe = fbCredentials
          ? await subscribeFacebookPageFeed(fbCredentials.pageId, fbCredentials.pageAccessToken)
          : { ok: false, error: 'Page credentials not found after connect' };
        if (!webhookSubscribe.ok) {
          fastify.log.warn(
            { err: webhookSubscribe.error },
            `Facebook Page feed webhook subscription failed for workspace ${workspaceId}`
          );
        }

        return reply.send({ success: true, ...result, webhookSubscribe });
      } catch (err: unknown) {
        if (err instanceof FacebookConnectError) {
          return reply.code(400).send({
            error: err.message,
            missingScopes: err.missingScopes,
            discovery: { pagesFound: err.pagesFound, pageNames: err.pageNames },
          });
        }
        const graphMessage =
          axios.isAxiosError(err) && err.response?.data
            ? JSON.stringify(err.response.data)
            : err instanceof Error
              ? err.message
              : 'Facebook connection failed';
        return reply.code(400).send({ error: graphMessage });
      }
    }

    if (body.pageId && body.pageAccessToken) {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          fbPageId: body.pageId,
          fbPageToken: encryptSecret(body.pageAccessToken),
          fbPageName: body.pageName,
        },
      });
      const webhookSubscribe = await subscribeFacebookPageFeed(
        body.pageId,
        body.pageAccessToken
      );
      if (!webhookSubscribe.ok) {
        fastify.log.warn(
          { err: webhookSubscribe.error },
          `Facebook Page feed webhook subscription failed for workspace ${workspaceId}`
        );
      }
      return reply.send({ success: true, webhookSubscribe });
    }

    return reply.code(400).send({ error: 'Missing Meta authorization code' });
  });

  fastify.delete('/disconnect', auth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { fbPageId: null, fbPageToken: null, fbPageName: null },
    });
    return { success: true };
  });

  fastify.get('/posts', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const workspace = await getWorkspacePageToken(workspaceId);
    if (!workspace?.fbPageId || !workspace.fbPageToken) {
      return reply.code(400).send({ error: 'Page not connected' });
    }

    try {
      const tokenInfo = await inspectPageAccessToken(workspace.fbPageToken);
      if (tokenInfo.missingScopes.includes('pages_read_engagement')) {
        return reply.code(403).send({
          error: `Missing pages_read_engagement permission.${permissionHint(tokenInfo.missingScopes)}`,
          missingScopes: tokenInfo.missingScopes,
          grantedScopes: tokenInfo.scopes,
        });
      }

      const data = await fetchFacebookPagePosts(workspace.fbPageId, workspace.fbPageToken);
      return { posts: normalizePosts(data as { data?: GraphPost[] }) };
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data) || err.message
        : 'Failed to fetch posts';
      return reply.code(400).send({ error: `${message}${permissionHint(['pages_read_engagement'])}` });
    }
  });

  fastify.get('/posts/:postId/comments', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { postId } = request.params as { postId: string };
    const workspace = await getWorkspacePageToken(workspaceId);
    if (!workspace?.fbPageToken) return reply.code(400).send({ error: 'Not connected' });

    try {
      const tokenInfo = await inspectPageAccessToken(workspace.fbPageToken);
      if (tokenInfo.missingScopes.includes('pages_read_user_content')) {
        return reply.code(403).send({
          error: `Missing pages_read_user_content permission.${permissionHint(tokenInfo.missingScopes)}`,
          missingScopes: tokenInfo.missingScopes,
          grantedScopes: tokenInfo.scopes,
        });
      }

      const res = await axios.get(`${GRAPH_API}/${postId}/comments`, {
        params: {
          fields: 'id,from,message,created_time,like_count,can_hide,can_remove',
          access_token: workspace.fbPageToken,
        },
      });

      const rawComments = res.data.data || [];
      const comments = rawComments.map(
        (c: {
          id: string;
          from?: { name?: string; picture?: { data?: { url?: string } } };
          message?: string;
          created_time?: string;
          like_count?: number;
          can_hide?: boolean;
          can_remove?: boolean;
        }) => ({
          id: c.id,
          from: {
            name: c.from?.name || 'Facebook User',
            picture: c.from?.picture?.data?.url,
          },
          message: c.message || '',
          createdTime: c.created_time || new Date().toISOString(),
          likeCount: c.like_count ?? 0,
          canHide: c.can_hide ?? true,
          canDelete: c.can_remove ?? true,
        })
      );

      // Backfill: comments made before the Page's feed webhook was subscribed
      // (or missed by it) never land in SocialComment otherwise — classification
      // and the review queue only ever see webhook-delivered comments.
      const { pendingClassifyIds } = await upsertListeningCommentsForPost({
        workspaceId,
        platform: 'facebook',
        postId,
        comments: rawComments.map(
          (c: { id: string; from?: { id?: string; name?: string }; message?: string; created_time?: string; like_count?: number }) => ({
            id: c.id,
            text: c.message || '',
            username: c.from?.name || null,
            fromId: c.from?.id || null,
            timestamp: c.created_time || null,
            likeCount: c.like_count ?? null,
            replies: [],
          })
        ),
      });
      triggerClassifyAfterUpsert(workspaceId, pendingClassifyIds);

      return { comments };
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data) || err.message
        : 'Failed to fetch comments';
      return reply.code(400).send({ error: message });
    }
  });

  // Comment reply/hide/delete moved to the unified Social Listening action
  // endpoint (POST /social-listening/comments/:id/action) — see
  // facebookListening.service.ts. Read-only post/comment browsing above
  // stays here, reused directly by Social Listening's Content tab.

  fastify.post('/posts', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { message, scheduledTime } = request.body as {
      message?: string;
      scheduledTime?: string;
    };
    const workspace = await getWorkspacePageToken(workspaceId);
    if (!workspace?.fbPageId || !workspace.fbPageToken) {
      return reply.code(400).send({ error: 'Page not connected' });
    }

    const payload: Record<string, unknown> = { message };
    if (scheduledTime) {
      payload.scheduled_publish_time = Math.floor(new Date(scheduledTime).getTime() / 1000);
      payload.published = false;
    }

    try {
      const res = await axios.post(`${GRAPH_API}/${workspace.fbPageId}/feed`, payload, {
        params: { access_token: workspace.fbPageToken },
      });
      return res.data;
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data) || err.message
        : 'Failed to create post';
      return reply.code(400).send({ error: msg });
    }
  });

  fastify.get('/insights', auth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const workspace = await getWorkspacePageToken(workspaceId);
    if (!workspace?.fbPageId || !workspace.fbPageToken) {
      return reply.code(400).send({ error: 'Page not connected' });
    }

    try {
      const tokenInfo = await inspectPageAccessToken(workspace.fbPageToken);
      if (tokenInfo.missingScopes.includes('read_insights')) {
        return reply.code(403).send({
          error: `Missing read_insights permission.${permissionHint(tokenInfo.missingScopes)}`,
          missingScopes: tokenInfo.missingScopes,
          grantedScopes: tokenInfo.scopes,
        });
      }

      const pageMeta = await getConnectedFacebookPage(workspaceId);
      const followersFallback =
        pageMeta.connected && 'followersCount' in pageMeta ? pageMeta.followersCount : 0;

      const { insights, daily } = await fetchPageInsights(
        workspace.fbPageId,
        workspace.fbPageToken,
        followersFallback
      );

      return {
        insights,
        daily,
        grantedScopes: tokenInfo.scopes,
        missingScopes: tokenInfo.missingScopes,
      };
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data) || err.message
        : 'Failed to fetch insights';
      return reply.code(400).send({ error: `${message}${permissionHint(['read_insights'])}` });
    }
  });
}
