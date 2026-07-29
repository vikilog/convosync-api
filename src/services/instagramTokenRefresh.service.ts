import axios from 'axios';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { decryptSecret } from '../lib/field-encryption.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

function appAccessToken(): string {
  return `${config.meta.appId}|${config.meta.appSecret}`;
}

type DebugTokenData = {
  is_valid?: boolean;
  expires_at?: number;
  data_access_expires_at?: number;
  error?: { message?: string; code?: number };
};

/**
 * Validate Instagram Page access tokens via Meta debug_token.
 * Page tokens from long-lived user tokens usually do not expire; when Meta
 * reports invalid, mark status "expired" so the UI prompts reconnect.
 */
export async function validateInstagramAccountTokens(): Promise<{
  checked: number;
  expired: number;
  errors: number;
}> {
  if (!config.meta.appId || !config.meta.appSecret) {
    return { checked: 0, expired: 0, errors: 0 };
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { status: { in: ['connected', 'error'] } },
    select: {
      id: true,
      pageAccessToken: true,
      username: true,
      workspaceId: true,
    },
  });

  let expired = 0;
  let errors = 0;
  const now = new Date();

  for (const account of accounts) {
    const token = decryptSecret(account.pageAccessToken);
    if (!token) {
      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: { status: 'error', tokenValidatedAt: now },
      });
      errors += 1;
      continue;
    }

    try {
      const res = await axios.get(`${GRAPH}/debug_token`, {
        params: {
          input_token: token,
          access_token: appAccessToken(),
        },
        timeout: 15_000,
      });
      const data = (res.data as { data?: DebugTokenData }).data || {};

      if (!data.is_valid) {
        await prisma.instagramAccount.update({
          where: { id: account.id },
          data: {
            status: 'expired',
            tokenValidatedAt: now,
            tokenExpiresAt: now,
          },
        });
        expired += 1;
        console.warn(
          `[instagram.token] marked expired workspace=${account.workspaceId} @${account.username || account.id}`
        );
        continue;
      }

      const expiresAtSec = data.expires_at || data.data_access_expires_at;
      const tokenExpiresAt =
        typeof expiresAtSec === 'number' && expiresAtSec > 0
          ? new Date(expiresAtSec * 1000)
          : null;

      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          status: 'connected',
          tokenValidatedAt: now,
          tokenExpiresAt,
        },
      });
    } catch (err) {
      errors += 1;
      console.error(
        `[instagram.token] validate failed workspace=${account.workspaceId} @${account.username || account.id}`,
        err
      );
      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: { status: 'error', tokenValidatedAt: now },
      });
    }
  }

  return { checked: accounts.length, expired, errors };
}
