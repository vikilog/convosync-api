import { createHash } from 'crypto';
import { FastifyInstance } from 'fastify';

export class CacheService {
  constructor(private fastify: FastifyInstance) {}

  get prisma() {
    return this.fastify.prisma;
  }

  get redis() {
    return this.fastify.redis;
  }

  private hashQuestion(question: string): string {
    return createHash('sha256')
      .update(question.toLowerCase().trim())
      .digest('hex')
      .substring(0, 32);
  }

  async getCachedResponse(params: {
    workspaceId: string;
    agentId: string;
    question: string;
  }): Promise<string | null> {
    const hash = this.hashQuestion(params.question);
    const redisKey = `cache:${params.workspaceId}:${params.agentId}:${hash}`;

    try {
      const cached = await this.redis.get(redisKey);
      if (cached) {
        this.prisma.cachedResponse
          .updateMany({
            where: {
              workspaceId: params.workspaceId,
              agentId: params.agentId,
              questionHash: hash,
            },
            data: { hitCount: { increment: 1 } },
          })
          .catch(() => {});
        return cached;
      }
    } catch {
      // Redis miss or error — fall through to DB
    }

    try {
      const dbCache = await this.prisma.cachedResponse.findUnique({
        where: {
          workspaceId_agentId_questionHash: {
            workspaceId: params.workspaceId,
            agentId: params.agentId,
            questionHash: hash,
          },
        },
      });

      if (dbCache && dbCache.expiresAt > new Date()) {
        const ttl = Math.floor((dbCache.expiresAt.getTime() - Date.now()) / 1000);
        if (ttl > 0) {
          await this.redis.setex(redisKey, ttl, dbCache.answer).catch(() => {});
        }
        await this.prisma.cachedResponse.update({
          where: { id: dbCache.id },
          data: { hitCount: { increment: 1 } },
        });
        return dbCache.answer;
      }
    } catch {
      // DB miss
    }

    return null;
  }

  async setCachedResponse(params: {
    workspaceId: string;
    agentId: string;
    question: string;
    answer: string;
    intent: string;
    ttlSeconds?: number;
  }): Promise<void> {
    const hash = this.hashQuestion(params.question);
    const ttl =
      params.ttlSeconds ?? parseInt(process.env.AI_CACHE_TTL_SECONDS || '3600', 10);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const redisKey = `cache:${params.workspaceId}:${params.agentId}:${hash}`;

    await this.redis.setex(redisKey, ttl, params.answer).catch(() => {});

    await this.prisma.cachedResponse.upsert({
      where: {
        workspaceId_agentId_questionHash: {
          workspaceId: params.workspaceId,
          agentId: params.agentId,
          questionHash: hash,
        },
      },
      create: {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        questionHash: hash,
        question: params.question,
        answer: params.answer,
        intent: params.intent,
        expiresAt,
      },
      update: {
        answer: params.answer,
        intent: params.intent,
        expiresAt,
      },
    });
  }

  shouldCache(intent: string, message: string): boolean {
    const nonCacheable = [
      'greeting',
      'farewell',
      'complaint',
      'human_request',
      'technical_support',
    ];
    if (nonCacheable.includes(intent)) return false;
    if (message.length < 5) return false;
    return true;
  }
}
