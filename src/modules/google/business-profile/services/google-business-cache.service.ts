import { getRedis } from '../../../../lib/redis.js';
import { GBP_CACHE_TTL } from '../constants/cache-ttl.js';

type CacheKind = keyof typeof GBP_CACHE_TTL;

function cacheKey(
  kind: CacheKind,
  workspaceId: string,
  connectionId: string,
  suffix = ''
): string {
  return `gbp:${kind}:${workspaceId}:${connectionId}${suffix ? `:${suffix}` : ''}`;
}

export class GoogleBusinessCacheService {
  async get<T>(
    kind: CacheKind,
    workspaceId: string,
    connectionId: string,
    suffix = ''
  ): Promise<T | null> {
    const raw = await getRedis().get(cacheKey(kind, workspaceId, connectionId, suffix));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(
    kind: CacheKind,
    workspaceId: string,
    connectionId: string,
    value: T,
    suffix = ''
  ): Promise<void> {
    const ttl = GBP_CACHE_TTL[kind];
    await getRedis().set(
      cacheKey(kind, workspaceId, connectionId, suffix),
      JSON.stringify(value),
      'EX',
      ttl
    );
  }

  async invalidateConnection(workspaceId: string, connectionId: string): Promise<void> {
    const pattern = `gbp:*:${workspaceId}:${connectionId}*`;
    const redis = getRedis();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

export const googleBusinessCacheService = new GoogleBusinessCacheService();
