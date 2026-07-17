import type { FastifyInstance } from 'fastify';
import type { RetrievalPath } from './types.js';

const PATHS: RetrievalPath[] = ['cache', 'direct', 'rag', 'full_llm', 'escalate'];

function statsKey(workspaceId: string, agentId: string): string {
  return `ai_route_stats:${workspaceId}:${agentId}`;
}

export async function recordRetrievalPath(
  fastify: FastifyInstance,
  workspaceId: string,
  agentId: string,
  path: RetrievalPath
): Promise<void> {
  const key = statsKey(workspaceId, agentId);
  try {
    await fastify.redis
      .multi()
      .hincrby(key, 'total', 1)
      .hincrby(key, path, 1)
      .exec();
  } catch {
    // analytics must never break replies
  }
}

export type RetrievalStats = {
  total: number;
  counts: Record<RetrievalPath, number>;
  percentages: Record<RetrievalPath, number>;
};

export async function getRetrievalStats(
  fastify: FastifyInstance,
  workspaceId: string,
  agentId: string
): Promise<RetrievalStats> {
  const empty = Object.fromEntries(PATHS.map((p) => [p, 0])) as Record<RetrievalPath, number>;
  try {
    const raw = await fastify.redis.hgetall(statsKey(workspaceId, agentId));
    const total = parseInt(raw.total || '0', 10);
    const counts = { ...empty };
    for (const p of PATHS) {
      counts[p] = parseInt(raw[p] || '0', 10);
    }
    const percentages = { ...empty };
    for (const p of PATHS) {
      percentages[p] = total > 0 ? Math.round((counts[p] / total) * 1000) / 10 : 0;
    }
    return { total, counts, percentages };
  } catch {
    return { total: 0, counts: empty, percentages: empty };
  }
}
