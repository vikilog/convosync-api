import {
  buildGoogleOAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  resolveGoogleRedirectUri,
} from '../lib/google-oauth.client.js';
import { scopesForAllProducts } from '../constants/scopes.js';
import { googleConnectionRepository } from '../repositories/google-connection.repository.js';
import type { GoogleAccountDetails } from '../types/google.types.js';

export const googleConnectService = {
  buildOAuthStateUrl(state: string, redirectUri?: string): string {
    return buildGoogleOAuthUrl({
      scopes: scopesForAllProducts(),
      state,
      redirectUri,
    });
  },

  resolveRedirectUri(redirectUri?: string): string {
    return resolveGoogleRedirectUri(redirectUri);
  },

  async connectAccount(params: {
    workspaceId: string;
    code: string;
    redirectUri?: string;
  }): Promise<GoogleAccountDetails> {
    const tokenBundle = await exchangeGoogleCode(params.code, params.redirectUri);
    const profile = await fetchGoogleUserInfo(tokenBundle.accessToken);

    const row = await googleConnectionRepository.upsertConnection({
      workspaceId: params.workspaceId,
      googleAccountId: profile.id,
      email: profile.email,
      tokens: {
        accessToken: tokenBundle.accessToken,
        refreshToken: tokenBundle.refreshToken,
      },
      scopes: tokenBundle.scopes,
      expiresAt: tokenBundle.expiresAt,
      displayName: profile.name,
      pictureUrl: profile.picture,
    });

    return {
      id: row.id,
      email: row.email,
      googleAccountId: row.googleAccountId,
      displayName: row.displayName,
      pictureUrl: row.pictureUrl,
      scopes: row.scopes,
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  },
};
