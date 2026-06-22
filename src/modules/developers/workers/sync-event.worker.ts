import { prisma } from '../../../index.js';
import { initDevelopersModule } from '../container.js';

const POLL_MS = 5000;

let started = false;

/** Processes pending developer sync events (knowledge rebuild queue). */
export function startDeveloperSyncWorker(): void {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      const { repo, aiSyncDashboardService } = initDevelopersModule(prisma);
      const pending = await repo.claimPendingSyncEvents(3);
      for (const event of pending) {
        try {
          await aiSyncDashboardService.processSyncEvent({
            id: event.id,
            workspaceId: event.workspaceId,
            eventType: event.eventType,
            payload: event.payload,
          });
        } catch (err) {
          console.warn('[DeveloperSyncWorker] Event failed:', event.id, err);
        }
      }
    } catch (err) {
      console.warn('[DeveloperSyncWorker] Poll error:', err);
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
  console.log('Developer sync worker started');
}
