import { FastifyInstance } from 'fastify';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getPlatformInfrastructureSnapshot } from '../../services/platformInfrastructure.js';

export default async function platformInfrastructureRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/', async () => getPlatformInfrastructureSnapshot());
}
