import axios from 'axios';
import { google } from 'googleapis';
import { config } from '../../../config.js';
import type { GoogleAuthClient } from '../providers/base.provider.js';
import type { GoogleTokenPayload } from '../types/google.types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function normalizeGoogleRedirectUri(uri: string): string {
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

export function isAllowedGoogleRedirectUri(uri: string): boolean {
  const normalized = normalizeGoogleRedirectUri(uri);
  const configured = normalizeGoogleRedirectUri(config.google.oauthRedirectUri);
  if (normalized === configured) return true;

  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== '/google/callback') return false;

    const origin = url.origin;
    if (config.corsAllowedOrigins.includes(origin)) return true;
    if (
      config.corsDevRelaxed &&
      (origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('https://localhost:') ||
        origin.startsWith('https://127.0.0.1:'))
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function resolveGoogleRedirectUri(preferred?: string): string {
  if (!preferred) return config.google.oauthRedirectUri;
  const normalized = normalizeGoogleRedirectUri(preferred);
  if (isAllowedGoogleRedirectUri(normalized)) return normalized;
  return config.google.oauthRedirectUri;
}

export function buildGoogleOAuthUrl(params: {
  scopes: string[];
  state: string;
  redirectUri?: string;
  loginHint?: string;
}): string {
  const redirectUri = resolveGoogleRedirectUri(params.redirectUri);
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUri
  );
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: params.scopes,
    state: params.state,
    include_granted_scopes: true,
    login_hint: params.loginHint,
  });
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri?: string
): Promise<GoogleTokenPayload & { expiresAt: Date | null; scopes: string[] }> {
  const resolved = resolveGoogleRedirectUri(redirectUri);
  const res = await axios.post(TOKEN_URL, null, {
    params: {
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: resolved,
      grant_type: 'authorization_code',
    },
  });

  const data = res.data as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error('Google did not return an access token');
  }
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token. Reconnect with consent.');
  }

  const expiresAt =
    typeof data.expires_in === 'number'
      ? new Date(Date.now() + data.expires_in * 1000)
      : null;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scopes: (data.scope || '').split(' ').filter(Boolean),
  };
}

export async function refreshGoogleTokens(
  refreshToken: string
): Promise<GoogleTokenPayload & { expiresAt: Date | null; scopes?: string[] }> {
  const res = await axios.post(TOKEN_URL, null, {
    params: {
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
  });

  const data = res.data as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error('Google token refresh failed');
  }

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt:
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000)
        : null,
    scopes: data.scope ? data.scope.split(' ').filter(Boolean) : undefined,
  };
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<{
  id: string;
  email: string;
  name?: string;
  picture?: string;
}> {
  const res = await axios.get(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = res.data as { id?: string; email?: string; name?: string; picture?: string };
  if (!data.id || !data.email) {
    throw new Error('Google userinfo missing id or email');
  }
  return { id: data.id, email: data.email, name: data.name, picture: data.picture };
}

export function createOAuth2Client(tokens: GoogleTokenPayload, redirectUri?: string): GoogleAuthClient {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    resolveGoogleRedirectUri(redirectUri)
  );
  oauth2.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  return oauth2;
}
