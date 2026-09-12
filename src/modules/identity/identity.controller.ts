import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../middleware/auth.js';
import { normalizeOptionalUrls } from '../../routes/workspace.schemas.js';
import { validateAvatarValue } from '../../services/userProfile.js';
import * as identityService from './identity.service.js';

export async function getMe(request: FastifyRequest, reply: FastifyReply) {
  const { userId, workspaceId } = getJwtUser(request);
  const result = await identityService.getMe(userId, workspaceId);
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return result.body;
}

export async function getCompany(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const result = await identityService.getCompany(workspaceId);
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return result.body;
}

export async function updateCompany(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const body = normalizeOptionalUrls(request.body as Record<string, unknown>);
  if ('logoUrl' in body) {
    body.logoUrl = validateAvatarValue(body.logoUrl as string | null | undefined);
  }
  const result = await identityService.updateCompany(workspaceId, body);
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return result.workspace;
}

export async function updateLocale(request: FastifyRequest) {
  const { workspaceId } = getJwtUser(request);
  return identityService.updateLocale(
    workspaceId,
    request.body as { country: string; timezone: string }
  );
}
