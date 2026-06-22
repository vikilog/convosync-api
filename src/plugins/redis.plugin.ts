import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import Redis from 'ioredis';
import { config } from '../config.js';

const redisPlugin: FastifyPluginAsync = async (fastify) => {
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  await redis.connect();
  fastify.decorate('redis', redis);

  fastify.addHook('onClose', async () => {
    await redis.quit();
  });
};

export default fp(redisPlugin, { name: 'redis' });

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}
