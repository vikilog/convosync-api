import { FastifyReply, FastifyRequest } from 'fastify';
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

function isSessionUserToken(user: JwtUser): boolean {
  return Boolean(user.userId) && user.scope !== 'platform' && !user.purpose;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
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
}

export function getJwtUser(request: FastifyRequest): JwtUser {
  return request.user as JwtUser;
}
