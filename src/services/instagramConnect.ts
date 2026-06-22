import axios from 'axios';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { assertChannelCreateAllowed } from './planUsageGuards.js';

export type InstagramConnectInput = {
  workspaceId: string;
  code: string;
  redirectUri?: string;
  pageId?: string;
};

export type InstagramConnectResult = {
  instagramUserId: string;
  pageId: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
  tokenType: 'PAGE';
};

export type InstagramConnectCandidatePublic = {
  pageId: string;
  pageName?: string;
  instagramUserId: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
  alreadyConnected?: boolean;
};

export type InstagramConnectSessionCandidate = InstagramConnectCandidatePublic & {
  pageAccessToken: string;
};

export type InstagramConnectPreviewResult = {
  requiresSelection: boolean;
  candidates: InstagramConnectCandidatePublic[];
};

type InstagramPageCandidate = {
  pageId: string;
  pageName?: string;
  pageAccessToken: string;
  instagramUserId: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
};

type RawPage = {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: {
    id?: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
  };
};

const GRAPH = 'https://graph.facebook.com/v19.0';
const PAGE_FIELDS =
  'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}';

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

export function resolveInstagramRedirectUri(preferred?: string): string {
  return (
    normalizeRedirectUri(preferred) ||
    normalizeRedirectUri(config.meta.instagramRedirectUri) ||
    config.meta.instagramRedirectUri
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

function appAccessToken(): string {
  return `${config.meta.appId}|${config.meta.appSecret}`;
}

/** Short-lived user token → long-lived user token (needed for long-lived Page tokens). */
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

type DebugTokenInfo = {
  is_valid?: boolean;
  type?: string;
  profile_id?: string;
};

async function inspectAccessToken(token: string): Promise<DebugTokenInfo> {
  const res = await axios.get(`${GRAPH}/debug_token`, {
    params: {
      input_token: token,
      access_token: appAccessToken(),
    },
  });
  return (res.data as { data?: DebugTokenInfo }).data || {};
}

async function assertIsPageAccessToken(token: string, pageId: string): Promise<string> {
  const debug = await inspectAccessToken(token);
  if (!debug.is_valid) {
    throw new Error('Meta returned an invalid access token for this Page');
  }
  if (debug.type !== 'PAGE') {
    throw new Error(
      `Expected a Page access token but Meta returned "${debug.type || 'USER'}". ` +
        'Grant Page permissions during connect; user tokens cannot send Instagram DMs.'
    );
  }
  if (debug.profile_id && debug.profile_id !== pageId) {
    throw new Error('Page access token does not match the selected Facebook Page');
  }
  return token;
}

async function fetchPageAccessTokenDirect(
  pageId: string,
  userAccessToken: string
): Promise<string | undefined> {
  try {
    const data = await graphGet<{ access_token?: string }>(pageId, userAccessToken, {
      fields: 'access_token',
    });
    return data.access_token;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a Page access token from me/accounts (preferred) or /{page-id}?fields=access_token.
 * Never returns the user OAuth token.
 */
async function resolvePageAccessToken(
  pageId: string,
  userAccessToken: string,
  managedPages: RawPage[]
): Promise<string> {
  const fromAccounts = managedPages.find((page) => page.id === pageId)?.access_token;
  const token = fromAccounts || (await fetchPageAccessTokenDirect(pageId, userAccessToken));
  if (!token) {
    throw new Error(
      `No Page access token for "${pageId}". Ensure you are Page admin and granted pages_show_list.`
    );
  }
  return assertIsPageAccessToken(token, pageId);
}

async function graphGet<T>(
  path: string,
  userAccessToken: string,
  params?: Record<string, string>
): Promise<T> {
  const res = await axios.get(`${GRAPH}/${path}`, {
    params,
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  return res.data as T;
}

type GraphListResponse = { data?: RawPage[]; paging?: { next?: string } };

async function fetchPaginatedPages(
  path: string,
  userAccessToken: string,
  params: Record<string, string>
): Promise<RawPage[]> {
  const pages: RawPage[] = [];
  let nextUrl: string | null = null;
  let first = true;

  while (first || nextUrl) {
    first = false;
    let listBody: GraphListResponse;
    if (nextUrl) {
      const res = await axios.get<GraphListResponse>(nextUrl);
      listBody = res.data;
    } else {
      const res = await axios.get<GraphListResponse>(`${GRAPH}/${path}`, {
        params,
        headers: { Authorization: `Bearer ${userAccessToken}` },
      });
      listBody = res.data;
    }

    pages.push(...(listBody.data || []));
    nextUrl = listBody.paging?.next || null;
  }

  return pages;
}

async function fetchUserManagedPages(userAccessToken: string): Promise<RawPage[]> {
  return fetchPaginatedPages('me/accounts', userAccessToken, {
    fields: PAGE_FIELDS,
    limit: '100',
  });
}

async function fetchBusinessOwnedPages(userAccessToken: string): Promise<RawPage[]> {
  try {
    const data = await graphGet<{
      data?: Array<{ owned_pages?: { data?: RawPage[] } }>;
    }>('me/businesses', userAccessToken, {
      fields: `owned_pages{${PAGE_FIELDS}}`,
      limit: '100',
    });

    const pages: RawPage[] = [];
    for (const business of data.data || []) {
      pages.push(...(business.owned_pages?.data || []));
    }
    return pages;
  } catch {
    return [];
  }
}

function mergePagesById(...groups: RawPage[][]): RawPage[] {
  const byId = new Map<string, RawPage>();
  for (const group of groups) {
    for (const page of group) {
      if (!page?.id) continue;
      const existing = byId.get(page.id);
      byId.set(page.id, {
        ...existing,
        ...page,
        access_token: page.access_token || existing?.access_token,
        instagram_business_account:
          page.instagram_business_account || existing?.instagram_business_account,
      });
    }
  }
  return [...byId.values()];
}

/** Business-owned pages often omit page access tokens; merge from me/accounts. */
function attachPageAccessTokens(pages: RawPage[], managedPages: RawPage[]): RawPage[] {
  const tokenById = new Map(
    managedPages.filter((page) => page.access_token).map((page) => [page.id, page.access_token!])
  );

  return pages.map((page) => ({
    ...page,
    access_token: page.access_token || tokenById.get(page.id),
  }));
}

async function enrichPageInstagram(page: RawPage, userAccessToken: string): Promise<RawPage> {
  if (page.instagram_business_account?.id) {
    return page;
  }

  if (!page.access_token) {
    try {
      const detail = await graphGet<RawPage>(page.id, userAccessToken, {
        fields: 'id,name,instagram_business_account{id,username,name,profile_picture_url}',
      });
      return {
        ...page,
        name: detail.name || page.name,
        instagram_business_account:
          detail.instagram_business_account || page.instagram_business_account,
      };
    } catch {
      return page;
    }
  }

  try {
    const detail = await graphGet<RawPage>(page.id, page.access_token, { fields: PAGE_FIELDS });
    return {
      ...page,
      name: detail.name || page.name,
      access_token: detail.access_token || page.access_token,
      instagram_business_account:
        detail.instagram_business_account || page.instagram_business_account,
    };
  } catch {
    return page;
  }
}

function buildNoInstagramAccountError(pages: RawPage[]): string {
  if (pages.length === 0) {
    return [
      'No Facebook Pages found for this Meta login.',
      'Use the Facebook profile that is admin of your Page, create a Page if needed,',
      'then link Instagram: Page settings → Linked accounts → Instagram (Professional account).',
    ].join(' ');
  }

  const pageNames = pages
    .map((page) => page.name || page.id)
    .slice(0, 5)
    .join(', ');

  return [
    `Found ${pages.length} Facebook Page(s) (${pageNames}) but none has a linked Instagram Professional account.`,
    'In Meta Business Suite or Page settings, connect Instagram (Business/Creator) to the Page, then try again.',
  ].join(' ');
}

export type InstagramDiscoverySummary = {
  pagesFound: number;
  pageNames: string[];
  instagramLinked: boolean;
};

export class InstagramConnectError extends Error {
  discovery: InstagramDiscoverySummary;

  constructor(message: string, discovery: InstagramDiscoverySummary) {
    super(message);
    this.name = 'InstagramConnectError';
    this.discovery = discovery;
  }
}

export class InstagramSelectionRequiredError extends Error {
  candidates: InstagramConnectCandidatePublic[];

  constructor(candidates: InstagramConnectCandidatePublic[]) {
    super('Multiple Instagram accounts found. Select one to connect.');
    this.name = 'InstagramSelectionRequiredError';
    this.candidates = candidates;
  }
}

async function discoverInstagramCandidates(userAccessToken: string): Promise<{
  candidates: InstagramPageCandidate[];
  mergedPages: RawPage[];
  managedPages: RawPage[];
}> {
  const [managedPages, businessPages] = await Promise.all([
    fetchUserManagedPages(userAccessToken),
    fetchBusinessOwnedPages(userAccessToken),
  ]);

  const merged = mergePagesById(managedPages, businessPages);
  const withTokens = attachPageAccessTokens(merged, managedPages);
  const enriched = await Promise.all(
    withTokens.map((page) => enrichPageInstagram(page, userAccessToken))
  );

  const candidates: InstagramPageCandidate[] = [];
  const seenIg = new Set<string>();

  for (const page of enriched) {
    const ig = page.instagram_business_account;
    if (!ig?.id) continue;

    let pageAccessToken: string;
    try {
      pageAccessToken = await resolvePageAccessToken(page.id, userAccessToken, managedPages);
    } catch {
      continue;
    }

    if (seenIg.has(ig.id)) continue;
    seenIg.add(ig.id);

    candidates.push({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken,
      instagramUserId: ig.id,
      username: ig.username,
      displayName: ig.name,
      profilePicture: ig.profile_picture_url,
    });
  }

  return { candidates, mergedPages: enriched, managedPages };
}

async function markAlreadyConnectedCandidates(
  workspaceId: string,
  candidates: InstagramPageCandidate[]
): Promise<InstagramConnectSessionCandidate[]> {
  if (candidates.length === 0) return [];

  const existing = await prisma.instagramAccount.findMany({
    where: {
      workspaceId,
      instagramUserId: { in: candidates.map((candidate) => candidate.instagramUserId) },
    },
    select: { instagramUserId: true },
  });
  const connectedIds = new Set(existing.map((account) => account.instagramUserId));

  return candidates.map((candidate) => ({
    pageId: candidate.pageId,
    pageName: candidate.pageName,
    instagramUserId: candidate.instagramUserId,
    username: candidate.username,
    displayName: candidate.displayName,
    profilePicture: candidate.profilePicture,
    pageAccessToken: candidate.pageAccessToken,
    alreadyConnected: connectedIds.has(candidate.instagramUserId),
  }));
}

function toPublicCandidates(
  candidates: InstagramConnectSessionCandidate[]
): InstagramConnectCandidatePublic[] {
  return candidates.map(({ pageAccessToken: _token, ...candidate }) => candidate);
}

export async function fetchMetaUserId(userAccessToken: string): Promise<string | undefined> {
  try {
    const me = await graphGet<{ id?: string }>('me', userAccessToken, { fields: 'id' });
    return me.id;
  } catch {
    return undefined;
  }
}

export async function previewInstagramConnect(input: {
  workspaceId: string;
  code: string;
  redirectUri?: string;
}): Promise<{
  sessionCandidates: InstagramConnectSessionCandidate[];
  preview: InstagramConnectPreviewResult;
  metaUserId?: string;
}> {
  const redirectUri = resolveInstagramRedirectUri(input.redirectUri);
  const shortUserToken = await exchangeCodeForToken(input.code, redirectUri);
  const userAccessToken = await exchangeForLongLivedUserToken(shortUserToken);
  const metaUserId = await fetchMetaUserId(userAccessToken);

  const { candidates, mergedPages } = await discoverInstagramCandidates(userAccessToken);

  if (candidates.length === 0) {
    throw new InstagramConnectError(buildNoInstagramAccountError(mergedPages), {
      pagesFound: mergedPages.length,
      pageNames: mergedPages.map((page) => page.name || page.id).slice(0, 10),
      instagramLinked: false,
    });
  }

  const sessionCandidates = await markAlreadyConnectedCandidates(input.workspaceId, candidates);
  const publicCandidates = toPublicCandidates(sessionCandidates);

  return {
    sessionCandidates,
    preview: {
      requiresSelection: publicCandidates.length > 1,
      candidates: publicCandidates,
    },
    metaUserId,
  };
}

export async function completeInstagramConnect(input: {
  workspaceId: string;
  pageId: string;
  candidates: InstagramConnectSessionCandidate[];
  metaUserId?: string;
}): Promise<InstagramConnectResult> {
  const selected = input.candidates.find((candidate) => candidate.pageId === input.pageId);
  if (!selected) {
    throw new Error('Selected Instagram account was not found in this connect session');
  }

  const existingInWorkspace = await prisma.instagramAccount.findUnique({
    where: {
      workspaceId_instagramUserId: {
        workspaceId: input.workspaceId,
        instagramUserId: selected.instagramUserId,
      },
    },
    select: { id: true },
  });
  if (!existingInWorkspace) {
    await assertChannelCreateAllowed(input.workspaceId);
  }

  await prisma.instagramAccount.upsert({
    where: {
      workspaceId_instagramUserId: {
        workspaceId: input.workspaceId,
        instagramUserId: selected.instagramUserId,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      instagramUserId: selected.instagramUserId,
      metaUserId: input.metaUserId,
      pageId: selected.pageId,
      pageName: selected.pageName,
      username: selected.username,
      displayName: selected.displayName,
      profilePicture: selected.profilePicture,
      pageAccessToken: selected.pageAccessToken,
    },
    update: {
      metaUserId: input.metaUserId,
      pageId: selected.pageId,
      pageName: selected.pageName,
      username: selected.username,
      displayName: selected.displayName,
      profilePicture: selected.profilePicture,
      pageAccessToken: selected.pageAccessToken,
    },
  });

  return {
    instagramUserId: selected.instagramUserId,
    pageId: selected.pageId,
    username: selected.username,
    displayName: selected.displayName || selected.pageName,
    profilePicture: selected.profilePicture,
    tokenType: 'PAGE',
  };
}

export async function connectWorkspaceInstagram(
  input: InstagramConnectInput
): Promise<InstagramConnectResult> {
  const { sessionCandidates, metaUserId } = await previewInstagramConnect({
    workspaceId: input.workspaceId,
    code: input.code,
    redirectUri: input.redirectUri,
  });

  const pageId =
    input.pageId ||
    (sessionCandidates.length === 1 ? sessionCandidates[0]?.pageId : undefined);

  if (!pageId) {
    throw new InstagramSelectionRequiredError(toPublicCandidates(sessionCandidates));
  }

  return completeInstagramConnect({
    workspaceId: input.workspaceId,
    pageId,
    candidates: sessionCandidates,
    metaUserId,
  });
}

export async function summarizeInstagramDiscovery(
  userAccessToken: string
): Promise<InstagramDiscoverySummary> {
  const { candidates, mergedPages } = await discoverInstagramCandidates(userAccessToken);
  return {
    pagesFound: mergedPages.length,
    pageNames: mergedPages.map((page) => page.name || page.id).slice(0, 10),
    instagramLinked: candidates.length > 0,
  };
}

export async function listInstagramAccounts(workspaceId: string) {
  return prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
}
