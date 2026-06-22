import { expireDueTrials } from '../services/trial.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly job to move expired trials to past_due.
 */
export function startTrialScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const count = await expireDueTrials();
      if (count > 0) {
        console.log(`Trial scheduler: expired ${count} trial(s)`);
      }
    } catch (err) {
      console.error('Trial scheduler tick failed', err);
    }
  };

  const timer = setInterval(() => void tick(), HOUR_MS);
  void tick();
  console.log('Trial expiry scheduler started (hourly)');
  return timer;
}
