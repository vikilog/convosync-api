import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, getJwtUser } from '../middleware/auth.js';
import { requireWorkspaceAccess } from '../middleware/workspaceScope.js';
import {
  completeOnboarding,
  getOnboardingState,
  saveOnboardingStep,
} from '../services/onboarding.js';

export default async function onboardingRoutes(fastify: FastifyInstance) {
  const auth = { onRequest: [authenticate, requireWorkspaceAccess] };

  fastify.get('/', auth, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    return getOnboardingState(userId, workspaceId);
  });

  fastify.patch('/step', auth, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    const body = z
      .object({
        step: z.number().int().min(1).max(7),
        skip: z.boolean().optional(),
        data: z.record(z.unknown()).optional(),
      })
      .parse(request.body);

    return saveOnboardingStep(userId, workspaceId, {
      step: body.step,
      skip: body.skip,
      data: body.data,
    });
  });

  fastify.post('/complete', auth, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    return completeOnboarding(userId, workspaceId);
  });
}
