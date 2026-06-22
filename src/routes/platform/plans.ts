import { FastifyInstance } from 'fastify';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import {
  listSubscriptionPlans,
  serializeSubscriptionPlan,
} from '../../services/subscriptionPlans.js';

export default async function platformPlanRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/', async () => {
    const plans = await listSubscriptionPlans();
    return { plans: plans.map(serializeSubscriptionPlan) };
  });
}
