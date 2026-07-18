import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { resolveMembershipAccess } from './workspaceMemberAdmin.js';

export const SESSION_JWT_EXPIRES_IN = '7d';
const TOKEN_VERSION_CACHE_TTL_SEC = 5 * 60;
const REDIS_OP_TIMEOUT_MS = 800;

function jtiBlacklistKey(jti: string) {
  return `blacklist:jti:${jti}`;
}

function tokenVersionCacheKey(userId: string) {
  return `tokenVersion:user:${userId}`;
}

async function withRedisTimeout<T>(op: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Redis operation timed out')),
          REDIS_OP_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Ensure a UserSecurityState row exists (signup / legacy users). */
export async function ensureUserSecurityState(userId: string) {
  return prisma.userSecurityState.upsert({
    where: { userId },
    create: { userId, tokenVersion: 0, updatedReason: 'ensure' },
    update: {},
  });
}

export async function getUserTokenVersion(userId: string): Promise<number> {
  const cached = await getCachedTokenVersion(userId);
  if (cached !== null) return cached;

  const row = await ensureUserSecurityState(userId);
  await setCachedTokenVersion(userId, row.tokenVersion);
  return row.tokenVersion;
}

async function getCachedTokenVersion(userId: string): Promise<number | null> {
  try {
    const raw = await withRedisTimeout(getRedis().get(tokenVersionCacheKey(userId)));
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    console.warn('[userSecurity] tokenVersion cache read failed; falling back to Postgres', err);
    return null;
  }
}

async function setCachedTokenVersion(userId: string, version: number): Promise<void> {
  try {
    await withRedisTimeout(
      getRedis().set(tokenVersionCacheKey(userId), String(version), 'EX', TOKEN_VERSION_CACHE_TTL_SEC)
    );
  } catch (err) {
    console.warn('[userSecurity] tokenVersion cache write failed', err);
  }
}

export async function invalidateTokenVersionCache(userId: string): Promise<void> {
  try {
    await withRedisTimeout(getRedis().del(tokenVersionCacheKey(userId)));
  } catch (err) {
    console.warn('[userSecurity] tokenVersion cache invalidate failed', err);
  }
}

/** Logout-everywhere / password change / admin revoke. */
export async function bumpTokenVersion(
  userId: string,
  reason: 'logout_all' | 'password_change' | 'admin_revoke' | string
): Promise<number> {
  await ensureUserSecurityState(userId);
  const updated = await prisma.userSecurityState.update({
    where: { userId },
    data: {
      tokenVersion: { increment: 1 },
      updatedReason: reason,
    },
  });
  await invalidateTokenVersionCache(userId);
  return updated.tokenVersion;
}

export class JtiBlacklistUnavailableError extends Error {
  constructor(message = 'Session revoke store unavailable; retry logout') {
    super(message);
    this.name = 'JtiBlacklistUnavailableError';
  }
}

/**
 * Blacklist a single jti until the JWT would expire.
 * Throws JtiBlacklistUnavailableError if Redis cannot store the entry (client should retry).
 */
export async function blacklistJti(jti: string, expUnixSeconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, expUnixSeconds - now);
  try {
    await withRedisTimeout(getRedis().set(jtiBlacklistKey(jti), '1', 'EX', ttl));
  } catch (err) {
    console.warn('[userSecurity] jti blacklist write failed', err);
    throw new JtiBlacklistUnavailableError();
  }
}

/**
 * Fail-open: returns false if Redis is unreachable (caller should log + allow).
 */
export async function isJtiBlacklisted(jti: string): Promise<boolean> {
  try {
    const hit = await withRedisTimeout(getRedis().get(jtiBlacklistKey(jti)));
    return hit != null;
  } catch (err) {
    console.warn(
      '[userSecurity] jti blacklist check failed (fail-open); relying on tokenVersion',
      err
    );
    return false;
  }
}

export type SessionTokenClaims = {
  userId: string;
  workspaceId: string;
  role: string;
  jti: string;
  tokenVersion: number;
  impersonatedBy?: string;
};

/** Issue a session JWT with jti + tokenVersion (used by login / switch / impersonation). */
export async function signSessionToken(
  fastify: FastifyInstance,
  input: {
    userId: string;
    workspaceId: string;
    expiresIn?: string;
    impersonatedBy?: string;
  }
): Promise<string> {
  const access = await resolveMembershipAccess(input.userId, input.workspaceId);
  const security = await ensureUserSecurityState(input.userId);
  const jti = randomUUID();

  const payload: SessionTokenClaims = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    role: access.role,
    jti,
    tokenVersion: security.tokenVersion,
    ...(input.impersonatedBy ? { impersonatedBy: input.impersonatedBy } : {}),
  };

  return fastify.jwt.sign(payload, {
    expiresIn: input.expiresIn ?? SESSION_JWT_EXPIRES_IN,
  });
}
