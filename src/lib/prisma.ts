import { PrismaClient } from '@prisma/client';
import {
  queryLogEnabled,
  recordPrismaQuery,
  slowQueryBucket,
  timingEnabled,
} from './request-timing.js';

/**
 * Process-wide Prisma singleton.
 *
 * Query event logging is opt-in (PERF_QUERY_LOG=true). Default is quiet —
 * Neon round-trips are often ≥50–100ms, so logging every query OOMs terminals.
 */
const globalForPrisma = globalThis as unknown as { __convosyncPrisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const wantQueryEvents = timingEnabled() || queryLogEnabled();

  const client = new PrismaClient({
    log: wantQueryEvents
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });

  if (wantQueryEvents) {
    client.$on('query', (e) => {
      const durationMs = e.duration;
      const paramCount = countParamsRedacted(e.params);
      const queryPreview = e.query.replace(/\s+/g, ' ').trim().slice(0, 240);
      const { model, action } = inferModelAction(queryPreview);
      const bucket = slowQueryBucket(durationMs);

      recordPrismaQuery({
        model,
        action,
        durationMs,
        paramCount,
        timestamp: e.timestamp.toISOString(),
        queryPreview,
      });

      // Console only when explicitly enabled — and only for very slow queries unless VERBOSE
      if (!queryLogEnabled()) return;

      const verbose = process.env.PERF_QUERY_LOG_VERBOSE === 'true';
      if (!verbose && durationMs < 250) return;

      const payload = {
        msg: 'prisma_query',
        durationMs,
        paramCount,
        timestamp: e.timestamp.toISOString(),
        target: e.target,
        model,
        action,
        query: queryPreview,
        slowBucket: bucket,
      };
      console.warn(JSON.stringify(payload));
    });
  }

  return client;
}

function countParamsRedacted(params: string): number {
  if (!params || params === '[]' || params === '{}') return 0;
  try {
    const parsed = JSON.parse(params) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length;
  } catch {
    // fall through
  }
  return (params.match(/,/g) || []).length + 1;
}

function inferModelAction(sql: string): { model: string; action: string } {
  const upper = sql.toUpperCase();
  let action = 'query';
  if (upper.startsWith('SELECT')) action = 'select';
  else if (upper.startsWith('INSERT')) action = 'insert';
  else if (upper.startsWith('UPDATE')) action = 'update';
  else if (upper.startsWith('DELETE')) action = 'delete';
  else if (upper.startsWith('BEGIN') || upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
    action = 'transaction';
  }

  const m = sql.match(/"(?:public"\.")?([A-Za-z0-9_]+)"/);
  return { model: m?.[1] ?? 'unknown', action };
}

export const prisma = globalForPrisma.__convosyncPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__convosyncPrisma = prisma;
}
