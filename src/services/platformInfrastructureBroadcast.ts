import { getPlatformInfrastructureSnapshot } from './platformInfrastructure.js';
import { getIo, PLATFORM_ROOM, platformRoomSize } from '../socket.js';

const EVENT = 'platform_infrastructure';
const INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;

export function ensurePlatformInfrastructureBroadcast(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  void tick();
}

async function tick(): Promise<void> {
  if (platformRoomSize() === 0) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  try {
    const snap = await getPlatformInfrastructureSnapshot();
    getIo().to(PLATFORM_ROOM).emit(EVENT, snap);
  } catch (err) {
    console.warn('[platform-infra] broadcast failed', err);
  }
}

/** Immediate snapshot for a newly joined socket (avoids waiting for next tick). */
export async function pushPlatformInfrastructureOnce(socketId: string): Promise<void> {
  try {
    const snap = await getPlatformInfrastructureSnapshot();
    getIo().to(socketId).emit(EVENT, snap);
  } catch (err) {
    console.warn('[platform-infra] push-once failed', err);
  }
}
