/**
 * Fastify request phase timing — instrumentation only.
 * Logs a breakdown when PERF_TIMING=true (opt-in; default off).
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import {
  createTimingStore,
  endPhase,
  enterRequestTiming,
  formatTimingBreakdown,
  startPhase,
  timingEnabled,
  type RequestTimingStore,
} from '../lib/request-timing.js';

declare module 'fastify' {
  interface FastifyRequest {
    __perfStore?: RequestTimingStore;
  }
}

const requestTimingPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request) => {
    if (!timingEnabled() && process.env.PERF_QUERY_LOG !== 'true') return;

    const store = createTimingStore(
      request.id,
      request.method,
      request.url.split('?')[0] || request.url
    );
    request.__perfStore = store;
    enterRequestTiming(store);
    startPhase('business');
  });

  fastify.addHook('preHandler', async (request) => {
    if (request.__perfStore) enterRequestTiming(request.__perfStore);
  });

  fastify.addHook('preSerialization', async (request) => {
    if (!request.__perfStore) return;
    enterRequestTiming(request.__perfStore);
    endPhase('business');
    startPhase('response');
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const store = request.__perfStore;
    if (!store) return;
    enterRequestTiming(store);
    endPhase('response');
    endPhase('business');

    if (timingEnabled()) {
      const total = Math.round(performance.now() - store.receivedAt);
      const breakdown = formatTimingBreakdown(store);
      request.log.info(
        {
          perf: {
            totalMs: total,
            authMs: Math.round(store.phaseMs.auth),
            validationMs: Math.round(store.phaseMs.validation),
            redisMs: Math.round(store.phaseMs.redis),
            prismaMs: Math.round(store.phaseMs.prisma),
            businessMs: Math.round(store.phaseMs.business),
            responseMs: Math.round(store.phaseMs.response),
            prismaQueries: store.prismaCount,
            redisOps: store.redisCount,
            statusCode: reply.statusCode,
            slowQueries: store.prismaQueries.filter((q) => q.durationMs >= 50),
          },
        },
        `perf_breakdown\n${breakdown}`
      );
    }
  });
};

export default fp(requestTimingPlugin, { name: 'request-timing' });
