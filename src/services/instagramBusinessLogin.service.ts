import axios from 'axios';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../lib/field-encryption.js';

/**
 * "Instagram API with Instagram Login" — a distinct Meta product from Facebook Login for
 * Business. Its OAuth host is instagram.com (not facebook.com) and its Graph host is
 * graph.instagram.com (not graph.facebook.com); the two token types are not interchangeable.
 */
const IG_OAUTH_HOST = 'https://www.instagram.com';
const IG_TOKEN_HOST = 'https://api.instagram.com';
const IG_GRAPH = 'https://graph.instagram.com/v21.0';

export const INSTAGRAM_BUSINESS_LOGIN_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
].join(',');

function graphErrorMessage(err: unknown): string {
  const ax = err as {
    response?: { data?: { error_message?: string; error?: { message?: string } } };
    message?: string;
  };
  return (
    ax.response?.data?.error_message ||
    ax.response?.data?.error?.message ||
    ax.message ||
    'Instagram Graph request failed'
  );
}

export function buildInstagramBusinessLoginUrl(state: string, redirectUri?: string): string {
  const url = new URL(`${IG_OAUTH_HOST}/oauth/authorize`);
  url.searchParams.set('client_id', config.instagramBusinessLogin.appId);
  url.searchParams.set('redirect_uri', redirectUri || config.instagramBusinessLogin.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', INSTAGRAM_BUSINESS_LOGIN_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

type ShortLivedTokenResponse = {
  data?: Array<{ access_token: string; user_id: string; permissions?: string[] }>;
  access_token?: string;
  user_id?: string;
};

async function exchangeCodeForShortLivedToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; instagramUserId: string }> {
  const body = new URLSearchParams({
    client_id: config.instagramBusinessLogin.appId,
    client_secret: config.instagramBusinessLogin.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  try {
    const res = await axios.post<ShortLivedTokenResponse>(
      `${IG_TOKEN_HOST}/oauth/access_token`,
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    // Meta's docs show both a flat shape and a `data[0]` shape depending on API version.
    const entry = res.data?.data?.[0];
    const accessToken = entry?.access_token || res.data?.access_token;
    const instagramUserId = entry?.user_id || res.data?.user_id;
    if (!accessToken || !instagramUserId) {
      throw new Error('Instagram did not return an access token');
    }
    return { accessToken, instagramUserId: String(instagramUserId) };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

async function exchangeForLongLivedToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  try {
    // Unversioned on purpose — graph.instagram.com/access_token (unlike /me, /replies, etc.)
    // does not accept a /v21.0 prefix; adding one causes a generic "Session key invalid" error
    // instead of a clear 400, because it gets routed as if validating a different token type.
    const res = await axios.get<{ access_token: string; expires_in: number }>(
      'https://graph.instagram.com/access_token',
      {
        params: {
          grant_type: 'ig_exchange_token',
          client_secret: config.instagramBusinessLogin.appSecret,
          access_token: shortLivedToken,
        },
      }
    );
    if (!res.data?.access_token) throw new Error('Instagram did not return a long-lived token');
    return { accessToken: res.data.access_token, expiresInSeconds: res.data.expires_in };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

async function fetchInstagramProfile(
  accessToken: string
): Promise<{ instagramUserId: string; username: string | null }> {
  try {
    const res = await axios.get<{ user_id?: string; id?: string; username?: string }>(
      `${IG_GRAPH}/me`,
      { params: { fields: 'user_id,username', access_token: accessToken } }
    );
    const instagramUserId = res.data?.user_id || res.data?.id;
    if (!instagramUserId) throw new Error('Instagram did not return a user id');
    return { instagramUserId: String(instagramUserId), username: res.data?.username ?? null };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

export type InstagramBusinessLoginResult = {
  instagramUserId: string;
  username: string | null;
  status: string;
};

export async function connectInstagramBusinessLogin(params: {
  workspaceId: string;
  code: string;
  redirectUri: string;
  connectedByUserId?: string;
}): Promise<InstagramBusinessLoginResult> {
  const { accessToken: shortLivedToken } = await exchangeCodeForShortLivedToken(
    params.code,
    params.redirectUri
  );
  const { accessToken, expiresInSeconds } = await exchangeForLongLivedToken(shortLivedToken);
  const profile = await fetchInstagramProfile(accessToken);

  const tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  await prisma.instagramBusinessLoginAccount.upsert({
    where: {
      workspaceId_instagramUserId: {
        workspaceId: params.workspaceId,
        instagramUserId: profile.instagramUserId,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      instagramUserId: profile.instagramUserId,
      username: profile.username,
      accessToken: encryptSecret(accessToken),
      status: 'connected',
      tokenExpiresAt,
      connectedByUserId: params.connectedByUserId,
    },
    update: {
      username: profile.username,
      accessToken: encryptSecret(accessToken),
      status: 'connected',
      tokenExpiresAt,
    },
  });

  return { instagramUserId: profile.instagramUserId, username: profile.username, status: 'connected' };
}

export async function listInstagramBusinessLoginAccounts(workspaceId: string) {
  const rows = await prisma.instagramBusinessLoginAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    instagramUserId: r.instagramUserId,
    username: r.username,
    status: r.status,
    tokenExpiresAt: r.tokenExpiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function resolveAccessToken(
  workspaceId: string,
  instagramUserId?: string | null
): Promise<string> {
  const account = instagramUserId
    ? await prisma.instagramBusinessLoginAccount.findFirst({
        where: { workspaceId, instagramUserId, status: 'connected' },
      })
    : await prisma.instagramBusinessLoginAccount.findFirst({
        where: { workspaceId, status: 'connected' },
        orderBy: { createdAt: 'desc' },
      });
  if (!account) throw new Error('No connected Instagram (business login) account found');
  const token = decryptSecret(account.accessToken);
  if (!token) throw new Error('Stored Instagram access token could not be decrypted');
  return token;
}

/** POST /{ig-comment-id}/replies — the primary instagram_business_manage_comments action. */
export async function replyToInstagramBusinessComment(
  workspaceId: string,
  commentId: string,
  message: string,
  instagramUserId?: string | null
): Promise<{ id: string }> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('Reply message is required');
  const accessToken = await resolveAccessToken(workspaceId, instagramUserId);
  try {
    const res = await axios.post<{ id?: string }>(`${IG_GRAPH}/${commentId}/replies`, null, {
      params: { message: trimmed, access_token: accessToken },
    });
    if (!res.data?.id) throw new Error('Reply failed — no comment id returned');
    return { id: res.data.id };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

/** POST /{ig-comment-id} with hide=true|false. */
export async function hideInstagramBusinessComment(
  workspaceId: string,
  commentId: string,
  hidden: boolean,
  instagramUserId?: string | null
): Promise<{ success: boolean }> {
  const accessToken = await resolveAccessToken(workspaceId, instagramUserId);
  try {
    const res = await axios.post<{ success?: boolean }>(`${IG_GRAPH}/${commentId}`, null, {
      params: { hide: hidden, access_token: accessToken },
    });
    return { success: res.data?.success ?? true };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

/** DELETE /{ig-comment-id}. */
export async function deleteInstagramBusinessComment(
  workspaceId: string,
  commentId: string,
  instagramUserId?: string | null
): Promise<{ success: boolean }> {
  const accessToken = await resolveAccessToken(workspaceId, instagramUserId);
  try {
    const res = await axios.delete<{ success?: boolean }>(`${IG_GRAPH}/${commentId}`, {
      params: { access_token: accessToken },
    });
    return { success: res.data?.success ?? true };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}
