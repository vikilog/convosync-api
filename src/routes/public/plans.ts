import type { FastifyInstance } from 'fastify';
import {
  listSubscriptionPlans,
  serializeLandingPlan,
} from '../../services/subscriptionPlans.js';

/** Unauthenticated catalog for marketing / landing. Active public plans only. */
export default async function publicPlanRoutes(fastify: FastifyInstance) {
  fastify.get('/', async () => {
    const plans = await listSubscriptionPlans();
    return { plans: plans.map(serializeLandingPlan) };
  });
}
