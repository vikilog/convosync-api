import { createHash } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../../config.js';
import { withBackoff } from './retry.js';

function hashQuestion(workspaceId: string, question: string): string {
  return createHash('sha256')
    .update(`${workspaceId}:${question.toLowerCase().trim()}`)
    .digest('hex')
    .substring(0, 32);
}

function cacheKey(workspaceId: string, agentId: string, question: string): string {
  return `ai_cache:${workspaceId}:${agentId}:${hashQuestion(workspaceId, question)}`;
}

export function cacheKeyPrefix(workspaceId: string): string {
  return `ai_cache:${workspaceId}:`;
}

/** Exact-match Redis cache. Redis down → miss (never fail the request). */
export async function checkRedisCache(
  fastify: FastifyInstance,
  params: { workspaceId: string; agentId: string; question: string }
): Promise<string | null> {
  const key = cacheKey(params.workspaceId, params.agentId, params.question);
  try {
    return await withBackoff(() => fastify.redis.get(key), { retries: 1, delayMs: 50 });
  } catch {
    return null;
  }
}

export async function setRedisCache(
  fastify: FastifyInstance,
  params: {
    workspaceId: string;
    agentId: string;
    question: string;
    answer: string;
    ttlSeconds?: number;
  }
): Promise<void> {
  const key = cacheKey(params.workspaceId, params.agentId, params.question);
  const ttl = params.ttlSeconds ?? config.ai.cacheTtlSeconds;
  try {
    await withBackoff(() => fastify.redis.setex(key, ttl, params.answer), {
      retries: 1,
      delayMs: 50,
    });
  } catch {
    // ponytail: cache write optional — request already succeeded
  }
}

/** Flush all hybrid cache keys for a workspace (KB update). */
export async function invalidateWorkspaceCache(
  fastify: FastifyInstance,
  workspaceId: string
): Promise<number> {
  const pattern = `${cacheKeyPrefix(workspaceId)}*`;
  let deleted = 0;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await fastify.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        deleted += await fastify.redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    console.error('[HybridRetrieval] cache invalidate failed', workspaceId, err);
  }
  return deleted;
}
