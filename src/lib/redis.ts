import IORedis from 'ioredis';
import { config } from '../config.js';

let client: IORedis | null = null;

export function getRedis(): IORedis {
  if (!client) {
    client = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
