import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate, getJwtUser } from '../../middleware/auth.js';
import { requireWorkspaceAccess } from '../../middleware/workspaceScope.js';
import { onboardingStepBodySchema } from '../../routes/onboarding.schemas.js';
import {
  completeOnboarding,
  getOnboardingState,
  saveOnboardingStep,
} from '../../services/onboarding.js';

export default async function onboardingRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = { onRequest: [authenticate, requireWorkspaceAccess] };

  app.get('/', auth, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    return getOnboardingState(userId, workspaceId);
  });

  app.patch('/step', { ...auth, schema: { body: onboardingStepBodySchema } }, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    const body = request.body;

    return saveOnboardingStep(userId, workspaceId, {
      step: body.step,
      skip: body.skip,
      data: body.data,
    });
  });

  app.post('/complete', auth, async (request) => {
    const { userId, workspaceId } = getJwtUser(request);
    return completeOnboarding(userId, workspaceId);
  });
}
