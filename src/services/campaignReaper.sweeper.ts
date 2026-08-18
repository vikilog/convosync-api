import { reapStuckCampaigns } from './campaignReaper.service.js';

const INTERVAL_MS = 5 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Periodically unstick campaigns left in 'running' by a crashed/killed worker. */
export function startCampaignReaperSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    void reapStuckCampaigns().catch((err) => {
      console.warn('[campaign-reaper] sweeper error', err);
    });
  }, INTERVAL_MS);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    timer.unref();
  }
}
