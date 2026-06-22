import { getRedis } from '../../../../lib/redis.js';

const RATE_KEY = 'gbp:google-api:rate';
const MIN_INTERVAL_MS = 1000;

/**
 * Global Google API rate limiter — max 1 request per second.
 * Uses Redis when available; sequential chain prevents Promise.all bursts.
 */
export class GoogleRateLimiterService {
  private chain: Promise<void> = Promise.resolve();

  async acquire(): Promise<void> {
    this.chain = this.chain.then(() => this.waitForSlot());
    return this.chain;
  }

  private async waitForSlot(): Promise<void> {
    const redis = getRedis();
    for (let i = 0; i < 120; i++) {
      const acquired = await redis.set(RATE_KEY, String(Date.now()), 'PX', MIN_INTERVAL_MS, 'NX');
      if (acquired === 'OK') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Google API rate limiter timeout');
  }
}

export const googleRateLimiterService = new GoogleRateLimiterService();
