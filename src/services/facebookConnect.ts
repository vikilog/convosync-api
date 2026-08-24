import axios from 'axios';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../lib/field-encryption.js';

const GRAPH = 'https://graph.facebook.com/v19.0';
const PAGE_FIELDS = 'id,name,category,access_token,picture.type(large)';

export const REQUIRED_FB_PAGE_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'read_insights',
] as const;

export type FacebookConnectInput = {
  workspaceId: string;
  code: string;
  redirectUri?: string;
  pageId?: string;
};

export type FacebookConnectResult = {
  pageId: string;
  pageName: string;
  category?: string;
  picture?: string;
  followersCount?: number;
  grantedScopes?: string[];
  missingScopes?: string[];
};

export type FacebookPageCandidatePublic = {
  pageId: string;
  pageName: string;
  category?: string;
  picture?: string;
};

export type FacebookPageSessionCandidate = FacebookPageCandidatePublic & {
  pageAccessToken: string;
};

type RawPage = {
  id: string;
  name?: string;
  category?: string;
  access_token?: string;
  picture?: { data?: { url?: string } };
  fan_count?: number;
  followers_count?: number;
};

export class FacebookConnectError extends Error {
  pagesFound: number;
  pageNames: string[];
  missingScopes?: string[];

  constructor(
    message: string,
    pagesFound = 0,
    pageNames: string[] = [],
    missingScopes?: string[]
  ) {
    super(message);
    this.name = 'FacebookConnectError';
    this.pagesFound = pagesFound;
    this.pageNames = pageNames;
    this.missingScopes = missingScopes;
  }
}

function appAccessToken(): string {
  return `${config.meta.appId}|${config.meta.appSecret}`;
}

export type PageTokenInfo = {
  isValid: boolean;
  type?: string;
  scopes: string[];
  profileId?: string;
  missingScopes: string[];
};

export async function inspectPageAccessToken(token: string): Promise<PageTokenInfo> {
  const res = await axios.get(`${GRAPH}/debug_token`, {
    params: {
      input_token: token,
      access_token: appAccessToken(),
    },
  });
  const data = (res.data as { data?: Record<string, unknown> }).data || {};
  const scopes = Array.isArray(data.scopes) ? (data.scopes as string[]) : [];
  const missingScopes = REQUIRED_FB_PAGE_SCOPES.filter((scope) => !scopes.includes(scope));

  return {
    isValid: !!data.is_valid,
    type: typeof data.type === 'string' ? data.type : undefined,
    scopes,
    profileId: typeof data.profile_id === 'string' ? data.profile_id : undefined,
    missingScopes: [...missingScopes],
  };
}

function normalizeRedirectUri(uri?: string): string | undefined {
  if (!uri) return undefined;
  try {
    const url = new URL(uri);
    url.hash = '';
    url.search = '';
    const path = url.pathname.replace(/\/+$/, '') || '';
    return `${url.origin}${path}`;
  } catch {
    return uri.replace(/\/+$/, '');
  }
}

export function resolveFacebookRedirectUri(preferred?: string): string {
  const fromEnv = process.env.FACEBOOK_OAUTH_REDIRECT_URI;
  return (
    normalizeRedirectUri(preferred) ||
    normalizeRedirectUri(fromEnv) ||
    `${config.frontendUrl}/facebook/callback`
  );
}

async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
  const tokenRes = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      code,
      redirect_uri: redirectUri,
    },
  });

  const accessToken = tokenRes.data.access_token;
  if (!accessToken) {
    throw new Error('Failed to get access token from Meta');
  }
  return accessToken;
}

async function exchangeForLongLivedUserToken(shortLivedToken: string): Promise<string> {
  try {
    const res = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: shortLivedToken,
      },
    });
    return res.data.access_token || shortLivedToken;
  } catch {
    return shortLivedToken;
  }
}

async function graphGet<T>(
  path: string,
  accessToken: string,
  params?: Record<string, string>
): Promise<T> {
  const res = await axios.get(`${GRAPH}/${path}`, {
    params: { ...params, access_token: accessToken },
  });
  return res.data as T;
}

async function fetchUserManagedPages(userAccessToken: string): Promise<RawPage[]> {
  const pages: RawPage[] = [];
  let nextUrl: string | null = null;
  let first = true;

  while (first || nextUrl) {
    first = false;
    let body: { data?: RawPage[]; paging?: { next?: string } };
    if (nextUrl) {
      const res = await axios.get(nextUrl);
      body = res.data;
    } else {
      body = await graphGet<{ data?: RawPage[]; paging?: { next?: string } }>(
        'me/accounts',
        userAccessToken,
        { fields: PAGE_FIELDS, limit: '100' }
      );
    }
    pages.push(...(body.data || []));
    nextUrl = body.paging?.next || null;
  }

  return pages;
}

async function resolvePageAccessToken(
  pageId: string,
  userAccessToken: string,
  managedPages: RawPage[]
): Promise<string> {
  const fromAccounts = managedPages.find((page) => page.id === pageId)?.access_token;
  if (fromAccounts) return fromAccounts;

  const detail = await graphGet<{ access_token?: string }>(pageId, userAccessToken, {
    fields: 'access_token',
  });
  if (!detail.access_token) {
    throw new Error(
      `No Page access token for "${pageId}". Ensure you are Page admin and granted pages_show_list.`
    );
  }
  return detail.access_token;
}

async function enrichPageDetails(page: RawPage, pageAccessToken: string): Promise<RawPage> {
  try {
    const detail = await graphGet<RawPage>(page.id, pageAccessToken, {
      fields: 'id,name,category,fan_count,followers_count,picture.type(large)',
    });
    return { ...page, ...detail };
  } catch {
    return page;
  }
}

/**
 * Exchanges the OAuth code once and lists every Page the user manages, without
 * picking one or writing to the workspace — lets the frontend show a picker
 * (mirrors previewInstagramConnect/completeInstagramConnect) instead of
 * silently connecting whichever Page Meta returned first.
 */
export async function previewFacebookConnect(input: {
  workspaceId: string;
  code: string;
  redirectUri?: string;
}): Promise<{
  sessionPages: FacebookPageSessionCandidate[];
  requiresSelection: boolean;
  pages: FacebookPageCandidatePublic[];
}> {
  const redirectUri = resolveFacebookRedirectUri(input.redirectUri);
  const shortUserToken = await exchangeCodeForToken(input.code, redirectUri);
  const userAccessToken = await exchangeForLongLivedUserToken(shortUserToken);

  const managedPages = await fetchUserManagedPages(userAccessToken);
  if (managedPages.length === 0) {
    throw new FacebookConnectError(
      'No Facebook Pages found for this Meta login. Use the profile that manages your Page.',
      0,
      []
    );
  }

  const sessionPages: FacebookPageSessionCandidate[] = [];
  for (const page of managedPages) {
    const pageAccessToken = await resolvePageAccessToken(page.id, userAccessToken, managedPages);
    sessionPages.push({
      pageId: page.id,
      pageName: page.name || page.id,
      category: page.category,
      picture: page.picture?.data?.url,
      pageAccessToken,
    });
  }

  const pages = sessionPages.map(({ pageAccessToken: _pageAccessToken, ...rest }) => rest);

  return {
    sessionPages,
    requiresSelection: sessionPages.length > 1,
    pages,
  };
}

/** Validates the selected Page's token and saves it to the workspace. */
export async function completeFacebookConnect(input: {
  workspaceId: string;
  pageId: string;
  pages: FacebookPageSessionCandidate[];
}): Promise<FacebookConnectResult> {
  const selected = input.pages.find((page) => page.pageId === input.pageId);
  if (!selected) {
    throw new Error('Selected Facebook Page was not found in this connect session');
  }

  const tokenInfo = await inspectPageAccessToken(selected.pageAccessToken);
  if (!tokenInfo.isValid) {
    throw new FacebookConnectError('Meta returned an invalid Page access token.', input.pages.length);
  }
  if (tokenInfo.type && tokenInfo.type !== 'PAGE') {
    throw new FacebookConnectError(
      `Expected a Page access token but Meta returned "${tokenInfo.type}". Reconnect and select your Page.`,
      input.pages.length
    );
  }
  if (tokenInfo.missingScopes.length > 0) {
    console.warn(
      `[facebook] Page token missing scopes: ${tokenInfo.missingScopes.join(', ')}`
    );
  }

  const enriched = await enrichPageDetails(
    { id: selected.pageId, name: selected.pageName, category: selected.category },
    selected.pageAccessToken
  );
  const picture = enriched.picture?.data?.url || selected.picture;

  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: {
      fbPageId: enriched.id,
      fbPageToken: encryptSecret(selected.pageAccessToken),
      fbPageName: enriched.name || enriched.id,
    },
  });

  return {
    pageId: enriched.id,
    pageName: enriched.name || enriched.id,
    category: enriched.category,
    picture,
    followersCount: enriched.followers_count ?? enriched.fan_count,
    grantedScopes: tokenInfo.scopes,
    missingScopes: tokenInfo.missingScopes,
  };
}

/** Legacy single-call path (code [+ pageId] in one request) — kept for direct callers that skip the preview step. */
export async function connectWorkspaceFacebook(
  input: FacebookConnectInput
): Promise<FacebookConnectResult> {
  const { sessionPages } = await previewFacebookConnect(input);
  const pageId = input.pageId || sessionPages[0].pageId;
  return completeFacebookConnect({
    workspaceId: input.workspaceId,
    pageId,
    pages: sessionPages,
  });
}

export async function getConnectedFacebookPage(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { fbPageId: true, fbPageToken: true, fbPageName: true },
  });

  const fbPageToken = decryptSecret(workspace?.fbPageToken);
  if (!workspace?.fbPageId || !fbPageToken) {
    return { connected: false as const };
  }

  let tokenInfo: PageTokenInfo | undefined;
  try {
    tokenInfo = await inspectPageAccessToken(fbPageToken);
  } catch {
    tokenInfo = undefined;
  }

  try {
    const detail = await graphGet<RawPage>(workspace.fbPageId, fbPageToken, {
      fields: 'id,name,category,fan_count,followers_count,picture.type(large)',
    });

    return {
      connected: true as const,
      id: detail.id,
      name: detail.name || workspace.fbPageName || detail.id,
      category: detail.category || 'Facebook Page',
      picture: detail.picture?.data?.url || '',
      followersCount: detail.followers_count ?? detail.fan_count ?? 0,
      grantedScopes: tokenInfo?.scopes ?? [],
      missingScopes: tokenInfo?.missingScopes ?? [],
      tokenValid: tokenInfo?.isValid ?? true,
    };
  } catch {
    return {
      connected: true as const,
      id: workspace.fbPageId,
      name: workspace.fbPageName || workspace.fbPageId,
      category: 'Facebook Page',
      picture: '',
      followersCount: 0,
      grantedScopes: tokenInfo?.scopes ?? [],
      missingScopes: tokenInfo?.missingScopes ?? REQUIRED_FB_PAGE_SCOPES.slice(),
      tokenValid: tokenInfo?.isValid ?? false,
    };
  }
}

const POST_FIELDS =
  'id,message,full_picture,created_time,likes.summary(true),comments.summary(true),shares,permalink_url';

type GraphPostList = { data?: Array<Record<string, unknown>> };

export async function fetchFacebookPagePosts(pageId: string, accessToken: string) {
  const edges = ['published_posts', 'feed', 'posts'] as const;
  let lastError: unknown;

  for (const edge of edges) {
    try {
      const res = await axios.get<GraphPostList>(`${GRAPH}/${pageId}/${edge}`, {
        params: {
          fields: POST_FIELDS,
          access_token: accessToken,
          limit: '10',
        },
      });
      return res.data;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

export async function fetchFacebookPageInsights(pageId: string, accessToken: string) {
  const metrics = [
    'page_follows',
    'page_daily_follows',
    'page_media_view',
    'page_total_media_view_unique',
    'page_post_engagements',
    'page_views_total',
  ] as const;

  const attempts: Array<Record<string, string>> = [
    { period: 'days_28', metric: metrics.join(',') },
    {
      period: 'day',
      metric: metrics.join(','),
      since: String(Math.floor(Date.now() / 1000) - 28 * 24 * 60 * 60),
      until: String(Math.floor(Date.now() / 1000)),
    },
  ];

  for (const params of attempts) {
    try {
      const res = await axios.get(`${GRAPH}/${pageId}/insights`, {
        params: { ...params, access_token: accessToken },
      });
      if (Array.isArray(res.data?.data) && res.data.data.length > 0) {
        return res.data;
      }
    } catch {
      // try next attempt / per-metric fallback below
    }
  }

  const merged: Array<{ name: string; values?: Array<{ value: number | Record<string, number> }> }> =
    [];
  for (const metric of metrics) {
    for (const period of ['days_28', 'day'] as const) {
      try {
        const res = await axios.get(`${GRAPH}/${pageId}/insights`, {
          params: {
            metric,
            period,
            access_token: accessToken,
            ...(period === 'day'
              ? {
                  since: String(Math.floor(Date.now() / 1000) - 28 * 24 * 60 * 60),
                  until: String(Math.floor(Date.now() / 1000)),
                }
              : {}),
          },
        });
        merged.push(...(res.data?.data || []));
        break;
      } catch {
        // try next period
      }
    }
  }

  return { data: merged };
}
