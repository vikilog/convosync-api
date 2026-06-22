import { FastifyReply, FastifyRequest } from 'fastify';

export interface JwtUser {
  userId?: string;
  workspaceId?: string;
  platformAdminId?: string;
  impersonatedBy?: string;
  role: string;
  purpose?: string;
  scope?: 'tenant' | 'platform';
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

export function getJwtUser(request: FastifyRequest): JwtUser {
  return request.user as JwtUser;
}
