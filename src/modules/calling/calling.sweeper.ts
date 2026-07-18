import { expireStaleCallsForWorkspace } from './calling.service.js';

const INTERVAL_MS = 15_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Periodically miss ring-timeout / accept-timeout calls and clean LiveKit rooms. */
export function startCallingSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    void expireStaleCallsForWorkspace().catch((err) => {
      console.warn('[calling] sweeper error', err);
    });
  }, INTERVAL_MS);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    timer.unref();
  }
}
