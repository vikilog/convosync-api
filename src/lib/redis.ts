import IORedis from 'ioredis';
import { config } from '../config.js';
import { recordRedisOp } from './request-timing.js';

let client: IORedis | null = null;

/** Instrument command wall time into request ALS (no behavior change). */
function instrumentRedis(redis: IORedis): IORedis {
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

export function getRedis(): IORedis {
  if (!client) {
    client = instrumentRedis(new IORedis(config.redisUrl, { maxRetriesPerRequest: null }));
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
