import { validateInstagramAccountTokens } from '../services/instagramTokenRefresh.service.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Periodically validates Instagram Page access tokens (debug_token).
 * Marks accounts expired/error when Meta reports invalid — user must reconnect.
 */
export function startInstagramTokenScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const result = await validateInstagramAccountTokens();
      if (result.checked > 0) {
        console.log(
          `Instagram token scheduler: checked=${result.checked} expired=${result.expired} errors=${result.errors}`
        );
      }
    } catch (err) {
      console.error('Instagram token scheduler tick failed', err);
    }
  };

  const timer = setInterval(() => void tick(), SIX_HOURS_MS);
  void tick();
  console.log('Instagram token validation scheduler started (every 6h)');
  return timer;
}
