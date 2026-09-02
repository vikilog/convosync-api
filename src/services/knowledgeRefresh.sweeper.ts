import { prisma } from '../index.js';
import { refreshOnlineDataItem } from './url-fetch.service.js';

const INTERVAL_MS = 60 * 60 * 1000; // hourly — matches the coarsest refresh option (daily)
const REFRESH_WINDOW_MS: Record<'daily' | 'weekly', number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};
const MAX_CANDIDATES = 200; // safety cap per sweep

function isDue(metadata: unknown, windowMs: number): boolean {
  const lastFetched = (metadata as { lastFetched?: string } | null)?.lastFetched;
  if (!lastFetched) return true;
  const last = new Date(lastFetched).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= windowMs;
}

/** Re-fetches online_data KB items whose `refreshInterval` (daily/weekly) is due. */
export async function sweepKnowledgeRefresh(): Promise<{ checked: number; refreshed: number }> {
  const candidates = await prisma.aiAgentKnowledgeItem.findMany({
    where: { type: 'online_data', status: 'ready', url: { not: null } },
    include: { agent: { select: { workspaceId: true } } },
    take: MAX_CANDIDATES,
  });

  let refreshed = 0;
  for (const item of candidates) {
    const interval = (item.metadata as { refreshInterval?: string } | null)?.refreshInterval;
    if (interval !== 'daily' && interval !== 'weekly') continue;
    if (!isDue(item.metadata, REFRESH_WINDOW_MS[interval])) continue;

    const result = await refreshOnlineDataItem(item, item.agent.workspaceId);
    if (result.success) {
      refreshed += 1;
    } else {
      console.warn('[knowledge-refresh] failed to refresh', item.id, result.error);
    }
  }

  return { checked: candidates.length, refreshed };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Periodically refreshes online_data KB items on their configured refresh interval. */
export function startKnowledgeRefreshSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepKnowledgeRefresh().catch((err) => {
      console.warn('[knowledge-refresh] sweeper error', err);
    });
  }, INTERVAL_MS);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    timer.unref();
  }
}
