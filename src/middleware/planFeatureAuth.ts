import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from './auth.js';
import { companyAuth } from './workspaceScope.js';
import {
  assertPlanFeature,
  PlanGateError,
  type PlanFeatureFlag,
} from '../services/planUsageGuards.js';

/** Same shape as companyAuth — JWT + workspace access + plan feature flag. */
export function planFeatureAuth(flag: PlanFeatureFlag) {
  const checkPlan = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    try {
      await assertPlanFeature(workspaceId, flag);
    } catch (err) {
      if (err instanceof PlanGateError) {
        return reply.code(403).send({ error: err.message, upgradePath: err.upgradePath });
      }
      throw err;
    }
  };

  return {
    onRequest: companyAuth.onRequest,
    preHandler: checkPlan,
  };
}
