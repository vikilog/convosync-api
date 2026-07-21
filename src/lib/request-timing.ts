/**
 * Request-scoped performance timing (AsyncLocalStorage).
 * Instrumentation only — does not change business logic.
 *
 * Opt-in only (default OFF — Neon RTT makes every query look “slow” and floods RAM):
 *   PERF_TIMING=true      → per-request Auth/Redis/Prisma breakdown
 *   PERF_QUERY_LOG=true   → log Prisma SQL previews (values never logged)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type TimingPhase =
  | 'auth'
  | 'validation'
  | 'redis'
  | 'prisma'
  | 'business'
  | 'response';

export type PrismaQuerySample = {
  model: string;
  action: string;
  durationMs: number;
  /** Redacted: param count only, never values */
  paramCount: number;
  timestamp: string;
  queryPreview: string;
};

export type RequestTimingStore = {
  reqId: string;
  method: string;
  url: string;
  receivedAt: number;
  phaseMs: Record<TimingPhase, number>;
  phaseStarted: Partial<Record<TimingPhase, number>>;
  prismaQueries: PrismaQuerySample[];
  prismaCount: number;
  redisCount: number;
};

const als = new AsyncLocalStorage<RequestTimingStore>();

const EMPTY_PHASES = (): Record<TimingPhase, number> => ({
  auth: 0,
  validation: 0,
  redis: 0,
  prisma: 0,
  business: 0,
  response: 0,
});

export function createTimingStore(
  reqId: string,
  method: string,
  url: string
): RequestTimingStore {
  return {
    reqId,
    method,
    url,
    receivedAt: performance.now(),
    phaseMs: EMPTY_PHASES(),
    phaseStarted: {},
    prismaQueries: [],
    prismaCount: 0,
    redisCount: 0,
  };
}

export function runWithTiming<T>(store: RequestTimingStore, fn: () => T): T {
  return als.run(store, fn);
}

/** Bind store to the current async resource (Fastify hooks / handlers). */
export function enterRequestTiming(store: RequestTimingStore): void {
  als.enterWith(store);
}

export function getTimingStore(): RequestTimingStore | undefined {
  return als.getStore();
}

export function startPhase(phase: TimingPhase): void {
  const store = als.getStore();
  if (!store) return;
  store.phaseStarted[phase] = performance.now();
}

export function endPhase(phase: TimingPhase): void {
  const store = als.getStore();
  if (!store) return;
  const started = store.phaseStarted[phase];
  if (started == null) return;
  store.phaseMs[phase] += performance.now() - started;
  delete store.phaseStarted[phase];
}

/** Accrue wall time for a phase without nested start/end (e.g. Prisma query event). */
export function addPhaseMs(phase: TimingPhase, ms: number): void {
  const store = als.getStore();
  if (!store || ms <= 0) return;
  store.phaseMs[phase] += ms;
}

export function recordPrismaQuery(sample: PrismaQuerySample): void {
  const store = als.getStore();
  if (!store) return;
  store.prismaCount += 1;
  store.phaseMs.prisma += sample.durationMs;
  if (store.prismaQueries.length < 50) {
    store.prismaQueries.push(sample);
  }
}

export function recordRedisOp(ms: number): void {
  const store = als.getStore();
  if (!store) return;
  store.redisCount += 1;
  store.phaseMs.redis += ms;
}

export function timingEnabled(): boolean {
  return process.env.PERF_TIMING === 'true';
}

export function queryLogEnabled(): boolean {
  return process.env.PERF_QUERY_LOG === 'true';
}

export function formatTimingBreakdown(store: RequestTimingStore): string {
  const total = performance.now() - store.receivedAt;
  const lines = [
    `${store.method} ${store.url}`,
    '',
    `Auth ............ ${Math.round(store.phaseMs.auth)}ms`,
    `Validation ...... ${Math.round(store.phaseMs.validation)}ms`,
    `Redis ........... ${Math.round(store.phaseMs.redis)}ms (${store.redisCount} ops)`,
    `Prisma .......... ${Math.round(store.phaseMs.prisma)}ms (${store.prismaCount} queries)`,
    `Business ........ ${Math.round(store.phaseMs.business)}ms`,
    `Response ........ ${Math.round(store.phaseMs.response)}ms`,
    '',
    `Total ........... ${Math.round(total)}ms`,
  ];
  return lines.join('\n');
}

export function slowQueryBucket(durationMs: number): '50' | '100' | '250' | '500' | null {
  if (durationMs >= 500) return '500';
  if (durationMs >= 250) return '250';
  if (durationMs >= 100) return '100';
  if (durationMs >= 50) return '50';
  return null;
}
