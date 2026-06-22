import { FastifyInstance } from 'fastify';
import IORedis from 'ioredis';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: IORedis;
  }
}

export async function redisPlugin(fastify: FastifyInstance) {
  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  fastify.decorate('redis', redis);
  fastify.addHook('onClose', async () => {
    await redis.quit();
  });
}
