import { FastifyReply, FastifyRequest } from 'fastify';
import { endPhase, enterRequestTiming, startPhase } from '../lib/request-timing.js';
import { getUserTokenVersion, isJtiBlacklisted } from '../services/userSecurity.js';

export interface JwtUser {
  userId?: string;
  workspaceId?: string;
  platformAdminId?: string;
  impersonatedBy?: string;
  role: string;
  purpose?: string;
  scope?: 'tenant' | 'platform';
  /** JWT ID — used for single-device logout blacklist */
  jti?: string;
  /** Must match UserSecurityState.tokenVersion */
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

/** Tenant session claims — authenticate() guarantees these for workspace routes. */
export type TenantJwtUser = JwtUser & { userId: string; workspaceId: string };

function isSessionUserToken(user: JwtUser): boolean {
  return Boolean(user.userId) && user.scope !== 'platform' && !user.purpose;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  if (request.__perfStore) enterRequestTiming(request.__perfStore);
  startPhase('auth');
  try {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (reply.sent) return;

    const user = getJwtUser(request);
    if (!isSessionUserToken(user) || !user.userId) return;

    // Durable gate: tokenVersion (Postgres, Redis-cached 5m)
    try {
      const currentVersion = await getUserTokenVersion(user.userId);
      const claimVersion = user.tokenVersion;
      if (typeof claimVersion !== 'number' || claimVersion !== currentVersion) {
        return reply.code(401).send({ error: 'Session invalidated' });
      }
    } catch (err) {
      request.log.error({ err }, 'tokenVersion check failed');
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Soft gate: jti blacklist (fail-open if Redis down)
    if (user.jti) {
      const revoked = await isJtiBlacklisted(user.jti);
      if (revoked) {
        return reply.code(401).send({ error: 'Token has been revoked' });
      }
    }
  } finally {
    endPhase('auth');
  }
}

export function getJwtUser(request: FastifyRequest): TenantJwtUser {
  // ponytail: platform-admin tokens omit these; tenant routes run after authenticate()
  return request.user as TenantJwtUser;
}
