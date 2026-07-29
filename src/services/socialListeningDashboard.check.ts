/**
 * ponytail: range helper self-check.
 * Run: npx tsx src/services/socialListeningDashboard.check.ts
 */
import { parseDashboardRange, rangeStart } from './socialListeningDashboard.service.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(parseDashboardRange('7d') === '7d', '7d');
assert(parseDashboardRange('bad') === '7d', 'default');
assert(parseDashboardRange('all') === 'all', 'all');

const now = new Date('2026-07-28T15:00:00Z');
assert(rangeStart('all', now) === null, 'all null');
const today = rangeStart('today', now);
assert(today != null && today.getHours() === 0, 'today midnight');
const week = rangeStart('7d', now);
assert(week != null && now.getTime() - week.getTime() >= 6 * 86400000, '7d back');

console.log('socialListeningDashboard.check: ok');
