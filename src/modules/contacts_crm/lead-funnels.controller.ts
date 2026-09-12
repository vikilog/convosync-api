import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../middleware/auth.js';
import type {
  FunnelIdParams,
  FunnelPatchBody,
  FunnelStageParams,
  FunnelStagePatchBody,
  FunnelStageWriteBody,
  FunnelWriteBody,
} from '../../routes/leadFunnels.schemas.js';
import {
  createFunnelStage,
  createLeadFunnel,
  deleteFunnelStage,
  deleteLeadFunnel,
  getFunnelInsights,
  getLeadFunnel,
  listFunnelStages,
  listLeadFunnels,
  updateFunnelStage,
  updateLeadFunnel,
} from '../../services/leadFunnel.service.js';

function catchStatus(err: unknown, fallback: string): { code: number; error: string } {
  const error = err instanceof Error ? err.message : fallback;
  return { code: /not found/i.test(error) ? 404 : 400, error };
}

export async function listFunnels(request: FastifyRequest) {
  const { workspaceId } = getJwtUser(request);
  const funnels = await listLeadFunnels(workspaceId);
  return { funnels };
}

export async function createFunnel(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  try {
    const funnel = await createLeadFunnel(workspaceId, request.body as FunnelWriteBody);
    return reply.code(201).send({ funnel });
  } catch (err) {
    const { error } = catchStatus(err, 'Create failed');
    return reply.code(400).send({ error });
  }
}

export async function getFunnel(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as FunnelIdParams;
  const funnel = await getLeadFunnel(workspaceId, id);
  if (!funnel) return reply.code(404).send({ error: 'Funnel not found' });
  return { funnel };
}

export async function getInsights(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as FunnelIdParams;
  const insights = await getFunnelInsights(workspaceId, id);
  if (!insights) return reply.code(404).send({ error: 'Funnel not found' });
  return { insights };
}

export async function patchFunnel(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as FunnelIdParams;
  try {
    const funnel = await updateLeadFunnel(workspaceId, id, request.body as FunnelPatchBody);
    return { funnel };
  } catch (err) {
    const { code, error } = catchStatus(err, 'Update failed');
    return reply.code(code).send({ error });
  }
}

export async function removeFunnel(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as FunnelIdParams;
  try {
    await deleteLeadFunnel(workspaceId, id);
    return { success: true };
  } catch (err) {
    const { code, error } = catchStatus(err, 'Delete failed');
    return reply.code(code).send({ error });
  }
}

export async function listStages(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as FunnelIdParams;
  try {
    const stages = await listFunnelStages(workspaceId, id);
    return { stages };
  } catch (err) {
    const { code, error } = catchStatus(err, 'Failed');
    return reply.code(code).send({ error });
  }
}

export async function createStage(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as FunnelIdParams;
  try {
    const stage = await createFunnelStage(
      workspaceId,
      id,
      request.body as FunnelStageWriteBody
    );
    return reply.code(201).send({ stage });
  } catch (err) {
    const { code, error } = catchStatus(err, 'Create failed');
    return reply.code(code).send({ error });
  }
}

export async function patchStage(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, stageId } = request.params as FunnelStageParams;
  try {
    const stage = await updateFunnelStage(
      workspaceId,
      id,
      stageId,
      request.body as FunnelStagePatchBody
    );
    return { stage };
  } catch (err) {
    const { code, error } = catchStatus(err, 'Update failed');
    return reply.code(code).send({ error });
  }
}

export async function removeStage(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id, stageId } = request.params as FunnelStageParams;
  try {
    await deleteFunnelStage(workspaceId, id, stageId);
    return { success: true };
  } catch (err) {
    const { code, error } = catchStatus(err, 'Delete failed');
    return reply.code(code).send({ error });
  }
}
