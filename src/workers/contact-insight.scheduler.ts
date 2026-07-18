import { config } from '../config.js';
import { findContactsNeedingInsight } from '../modules/contact-insight/contact-insight.service.js';
import { enqueueContactInsight } from '../queue/contact-insight.queue.js';

const HOUR_MS = 60 * 60 * 1000;
let lastNightlyYmd = '';

function ymdInLocal(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Hourly tick; once per calendar day at CONTACT_INSIGHT_NIGHTLY_HOUR, scan + enqueue.
 * Mirrors trial.scheduler pattern (no separate cron daemon).
 */
export function startContactInsightScheduler(): NodeJS.Timeout | null {
  if (!config.contactInsight.enabled) {
    console.log('[contact-insight] nightly scheduler skipped');
    return null;
  }

  const tick = async () => {
    const now = new Date();
    if (now.getHours() !== config.contactInsight.nightlyHour) return;
    const key = ymdInLocal(now);
    if (key === lastNightlyYmd) return;
    lastNightlyYmd = key;

    try {
      const contacts = await findContactsNeedingInsight();
      console.log(`[contact-insight] nightly scan: ${contacts.length} contact(s)`);
      for (const c of contacts) {
        await enqueueContactInsight({
          workspaceId: c.workspaceId,
          contactId: c.contactId,
          reason: 'nightly',
        });
      }
    } catch (err) {
      console.error('[contact-insight] nightly scan failed', err);
    }
  };

  const timer = setInterval(() => void tick(), HOUR_MS);
  void tick();
  console.log(
    `[contact-insight] nightly scheduler started (hour=${config.contactInsight.nightlyHour})`
  );
  return timer;
}
