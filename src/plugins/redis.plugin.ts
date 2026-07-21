import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import Redis from 'ioredis';
import { config } from '../config.js';
import { recordRedisOp } from '../lib/request-timing.js';

function instrumentRedis(redis: Redis): Redis {
  const proto = Object.getPrototypeOf(redis) as { sendCommand?: (...args: unknown[]) => unknown };
  if (!proto?.sendCommand || (redis as { __perfInstrumented?: boolean }).__perfInstrumented) {
    return redis;
  }
  const original = proto.sendCommand.bind(redis);
  (redis as { sendCommand: typeof proto.sendCommand }).sendCommand = (...args: unknown[]) => {
    const t0 = performance.now();
    const result = original(...args) as Promise<unknown> | unknown;
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).finally(() => {
        recordRedisOp(performance.now() - t0);
      });
    }
    recordRedisOp(performance.now() - t0);
    return result;
  };
  (redis as { __perfInstrumented?: boolean }).__perfInstrumented = true;
  return redis;
}

const redisPlugin: FastifyPluginAsync = async (fastify) => {
  const redis = instrumentRedis(
    new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })
  );

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
