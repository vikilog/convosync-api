import { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from './auth.js';

export async function authenticatePlatformAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const user = getJwtUser(request);
  if (user.scope !== 'platform' || !user.platformAdminId) {
    return reply.code(403).send({ error: 'Platform admin access required' });
  }
}
