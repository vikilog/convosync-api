import { Queue } from 'bullmq';
import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { sampleHostCpuPct, sampleHostRam } from './hostMetrics.js';

const QUEUE_NAMES = [
  'campaign-broadcast',
  'contact-insight-compute',
  'call-transcript',
  'journey-delay',
  'gbp-sync',
] as const;

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };
const HISTORY_MAX = 36;

export type InfraStatus = 'healthy' | 'degraded' | 'down';

export type HostHistoryPoint = {
  t: string;
  cpu: number;
  ram: number;
  disk: number;
  netRx: number;
  netTx: number;
};

export type PlatformInfrastructureSnapshot = {
  checkedAt: string;
  status: InfraStatus;
  api: {
    uptimeSec: number;
    nodeVersion: string;
    pid: number;
    heapUsedMb: number;
    heapTotalMb: number;
    rssMb: number;
    env: string;
  };
  host: {
    cpuPct: number;
    cpuCores: number;
    load1: number;
    ramUsedMb: number;
    ramTotalMb: number;
    ramPct: number;
    diskUsedGb: number;
    diskTotalGb: number;
    diskPct: number;
    diskPath: string;
    networkRxKbps: number | null;
    networkTxKbps: number | null;
    networkSupported: boolean;
  };
  history: HostHistoryPoint[];
  postgres: {
    status: 'healthy' | 'down';
    latencyMs: number;
    database: string | null;
    sizeBytes: number | null;
    activeConnections: number | null;
    maxConnections: number | null;
    error: string | null;
  };
  redis: {
    status: 'healthy' | 'down';
    latencyMs: number;
    usedMemoryBytes: number | null;
    maxMemoryBytes: number | null;
    connectedClients: number | null;
    version: string | null;
    error: string | null;
  };
  queues: Array<{
    name: string;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
  }>;
  services: Array<{
    name: string;
    provider: string;
    status: 'healthy' | 'warning' | 'down';
    latencyMs: number | null;
    detail: string | null;
  }>;
  alerts: Array<{
    id: string;
    severity: 'warning' | 'info';
    title: string;
    detail: string;
  }>;
};

const hostHistory: HostHistoryPoint[] = [];
let prevNet: { rx: number; tx: number; at: number } | null = null;

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function gb(bytes: number): number {
  return Math.round((bytes / (1024 ** 3)) * 100) / 100;
}

async function readNetCounters(): Promise<{ rx: number; tx: number } | null> {
  try {
    const text = await readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const iface = parts[0]?.replace(':', '') ?? '';
      if (!iface || iface === 'lo') continue;
      rx += Number(parts[1]) || 0;
      tx += Number(parts[9]) || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

async function sampleHost(): Promise<PlatformInfrastructureSnapshot['host']> {
  const [{ cpuPct, cores, load1 }, ram] = await Promise.all([
    sampleHostCpuPct(),
    sampleHostRam(),
  ]);

  const ramUsedMb = mb(ram.usedBytes);
  const ramTotalMb = mb(ram.totalBytes);
  const ramPct =
    ram.totalBytes > 0 ? Math.round((ram.usedBytes / ram.totalBytes) * 100) : 0;

  let diskUsedGb = 0;
  let diskTotalGb = 0;
  let diskPct = 0;
  const diskPath = process.cwd();
  try {
    const s = await statfs(diskPath);
    const total = Number(s.blocks) * Number(s.bsize);
    // bavail = free to non-root (what `df` / Finder show)
    const free = Number(s.bavail ?? s.bfree) * Number(s.bsize);
    const used = Math.max(0, total - free);
    diskTotalGb = gb(total);
    diskUsedGb = gb(used);
    diskPct = total > 0 ? Math.round((used / total) * 100) : 0;
  } catch {
    /* keep zeros */
  }

  let networkRxKbps: number | null = null;
  let networkTxKbps: number | null = null;
  let networkSupported = false;
  const counters = await readNetCounters();
  if (counters) {
    networkSupported = true;
    const now = Date.now();
    if (prevNet && now > prevNet.at) {
      const dtSec = (now - prevNet.at) / 1000;
      networkRxKbps = Math.max(0, Math.round(((counters.rx - prevNet.rx) * 8) / 1000 / dtSec));
      networkTxKbps = Math.max(0, Math.round(((counters.tx - prevNet.tx) * 8) / 1000 / dtSec));
    } else {
      networkRxKbps = 0;
      networkTxKbps = 0;
    }
    prevNet = { ...counters, at: now };
  }

  return {
    cpuPct,
    cpuCores: cores,
    load1,
    ramUsedMb,
    ramTotalMb,
    ramPct,
    diskUsedGb,
    diskTotalGb,
    diskPct,
    diskPath,
    networkRxKbps,
    networkTxKbps,
    networkSupported,
  };
}

function pushHostHistory(host: PlatformInfrastructureSnapshot['host'], checkedAt: string) {
  hostHistory.push({
    t: checkedAt,
    cpu: host.cpuPct,
    ram: host.ramPct,
    disk: host.diskPct,
    netRx: host.networkRxKbps ?? 0,
    netTx: host.networkTxKbps ?? 0,
  });
  while (hostHistory.length > HISTORY_MAX) hostHistory.shift();
}

async function checkPostgres(): Promise<PlatformInfrastructureSnapshot['postgres']> {
  const t0 = performance.now();
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        db: string | null;
        size_bytes: bigint | number | null;
        active: bigint | number | null;
        max_conn: bigint | number | null;
      }>
    >`
      SELECT
        current_database() AS db,
        pg_database_size(current_database()) AS size_bytes,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS active,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn
    `;
    const row = rows[0];
    return {
      status: 'healthy',
      latencyMs: Math.round(performance.now() - t0),
      database: row?.db ?? null,
      sizeBytes: row?.size_bytes != null ? Number(row.size_bytes) : null,
      activeConnections: row?.active != null ? Number(row.active) : null,
      maxConnections: row?.max_conn != null ? Number(row.max_conn) : null,
      error: null,
    };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - t0),
      database: null,
      sizeBytes: null,
      activeConnections: null,
      maxConnections: null,
      error: err instanceof Error ? err.message : 'Postgres check failed',
    };
  }
}

function parseRedisInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes(':')) continue;
    const i = trimmed.indexOf(':');
    out[trimmed.slice(0, i)] = trimmed.slice(i + 1);
  }
  return out;
}

async function checkRedis(): Promise<PlatformInfrastructureSnapshot['redis']> {
  const t0 = performance.now();
  try {
    const redis = getRedis();
    await redis.ping();
    const latencyMs = Math.round(performance.now() - t0);
    const info = parseRedisInfo(await redis.info());
    const maxMemory = Number(info.maxmemory || 0);
    return {
      status: 'healthy',
      latencyMs,
      usedMemoryBytes: Number(info.used_memory || 0) || null,
      maxMemoryBytes: maxMemory > 0 ? maxMemory : null,
      connectedClients: Number(info.connected_clients || 0) || null,
      version: info.redis_version ?? null,
      error: null,
    };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - t0),
      usedMemoryBytes: null,
      maxMemoryBytes: null,
      connectedClients: null,
      version: null,
      error: err instanceof Error ? err.message : 'Redis check failed',
    };
  }
}

async function checkQueues(): Promise<PlatformInfrastructureSnapshot['queues']> {
  const queues = QUEUE_NAMES.map((name) => new Queue(name, { connection }));
  try {
    return await Promise.all(
      queues.map(async (q) => {
        try {
          const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
          return {
            name: q.name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          };
        } catch {
          return { name: q.name, waiting: 0, active: 0, delayed: 0, failed: 0 };
        }
      })
    );
  } finally {
    await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
  }
}

function buildAlerts(
  postgres: PlatformInfrastructureSnapshot['postgres'],
  redis: PlatformInfrastructureSnapshot['redis'],
  queues: PlatformInfrastructureSnapshot['queues'],
  api: PlatformInfrastructureSnapshot['api'],
  host: PlatformInfrastructureSnapshot['host']
): PlatformInfrastructureSnapshot['alerts'] {
  const alerts: PlatformInfrastructureSnapshot['alerts'] = [];

  if (postgres.status === 'down') {
    alerts.push({
      id: 'pg-down',
      severity: 'warning',
      title: 'PostgreSQL unreachable',
      detail: postgres.error ?? 'Database ping failed',
    });
  } else if (
    postgres.activeConnections != null &&
    postgres.maxConnections != null &&
    postgres.activeConnections / postgres.maxConnections >= 0.8
  ) {
    alerts.push({
      id: 'pg-conn',
      severity: 'warning',
      title: 'Postgres connection pool high',
      detail: `${postgres.activeConnections} / ${postgres.maxConnections} connections in use`,
    });
  }

  if (redis.status === 'down') {
    alerts.push({
      id: 'redis-down',
      severity: 'warning',
      title: 'Redis unreachable',
      detail: redis.error ?? 'Redis ping failed',
    });
  }

  const failed = queues.reduce((s, q) => s + q.failed, 0);
  if (failed > 0) {
    alerts.push({
      id: 'queue-failed',
      severity: 'warning',
      title: `${failed} failed job${failed === 1 ? '' : 's'} in BullMQ`,
      detail: queues
        .filter((q) => q.failed > 0)
        .map((q) => `${q.name}: ${q.failed}`)
        .join(' · '),
    });
  }

  const waiting = queues.reduce((s, q) => s + q.waiting + q.delayed, 0);
  if (waiting >= 500) {
    alerts.push({
      id: 'queue-backlog',
      severity: 'warning',
      title: 'Queue backlog elevated',
      detail: `${waiting} waiting/delayed jobs across workers`,
    });
  }

  const heapPct = api.heapTotalMb > 0 ? api.heapUsedMb / api.heapTotalMb : 0;
  if (heapPct >= 0.85) {
    alerts.push({
      id: 'heap-high',
      severity: 'warning',
      title: 'API heap usage high',
      detail: `${api.heapUsedMb} / ${api.heapTotalMb} MB (${Math.round(heapPct * 100)}%)`,
    });
  }

  if (host.cpuPct >= 85) {
    alerts.push({
      id: 'cpu-high',
      severity: 'warning',
      title: 'Host CPU load high',
      detail: `${host.cpuPct}% · load1 ${host.load1} on ${host.cpuCores} cores`,
    });
  }

  if (host.ramPct >= 90) {
    alerts.push({
      id: 'ram-high',
      severity: 'warning',
      title: 'Host RAM usage high',
      detail: `${host.ramUsedMb} / ${host.ramTotalMb} MB (${host.ramPct}%)`,
    });
  }

  if (host.diskPct >= 85) {
    alerts.push({
      id: 'disk-high',
      severity: 'warning',
      title: 'Disk usage high',
      detail: `${host.diskUsedGb} / ${host.diskTotalGb} GB on ${host.diskPath}`,
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      id: 'ok',
      severity: 'info',
      title: 'No active infrastructure alerts',
      detail: 'Postgres, Redis, and queues are within normal thresholds.',
    });
  }

  return alerts;
}

export async function getPlatformInfrastructureSnapshot(): Promise<PlatformInfrastructureSnapshot> {
  const mem = process.memoryUsage();
  const checkedAt = new Date().toISOString();
  const api: PlatformInfrastructureSnapshot['api'] = {
    uptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
    pid: process.pid,
    heapUsedMb: mb(mem.heapUsed),
    heapTotalMb: mb(mem.heapTotal),
    rssMb: mb(mem.rss),
    env: process.env.NODE_ENV || 'development',
  };

  const [postgres, redis, queues, host] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkQueues(),
    sampleHost(),
  ]);

  pushHostHistory(host, checkedAt);

  const services: PlatformInfrastructureSnapshot['services'] = [
    {
      name: 'API process',
      provider: `Node ${api.nodeVersion}`,
      status: 'healthy',
      latencyMs: null,
      detail: `pid ${api.pid} · uptime ${formatUptime(api.uptimeSec)}`,
    },
    {
      name: 'PostgreSQL',
      provider: postgres.database ?? 'Postgres',
      status: postgres.status === 'healthy' ? 'healthy' : 'down',
      latencyMs: postgres.latencyMs,
      detail: postgres.error,
    },
    {
      name: 'Redis',
      provider: redis.version ? `Redis ${redis.version}` : 'Redis',
      status: redis.status === 'healthy' ? 'healthy' : 'down',
      latencyMs: redis.latencyMs,
      detail: redis.error,
    },
    {
      name: 'BullMQ',
      provider: 'Self-hosted',
      status: queues.some((q) => q.failed > 0) ? 'warning' : redis.status === 'healthy' ? 'healthy' : 'down',
      latencyMs: null,
      detail: `${queues.reduce((s, q) => s + q.waiting + q.active + q.delayed, 0)} open jobs`,
    },
  ];

  const alerts = buildAlerts(postgres, redis, queues, api, host);
  const status: InfraStatus =
    postgres.status === 'down' || redis.status === 'down'
      ? 'down'
      : alerts.some((a) => a.severity === 'warning')
        ? 'degraded'
        : 'healthy';

  return {
    checkedAt,
    status,
    api,
    host,
    history: [...hostHistory],
    postgres,
    redis,
    queues,
    services,
    alerts,
  };
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
