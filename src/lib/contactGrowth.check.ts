import {
  wallTimeToUtc,
  zonedHourKey,
  zonedYmd,
  resolveGrowthWindow,
  buildGrowthBuckets,
} from './contactGrowth.ts';

const tz = 'Asia/Kolkata';

// Midnight IST 2024-06-15 = 2024-06-14T18:30:00.000Z
const midnight = wallTimeToUtc(tz, 2024, 6, 15, 0, 0, 0, 0);
if (midnight.toISOString() !== '2024-06-14T18:30:00.000Z') {
  throw new Error(`midnight IST got ${midnight.toISOString()}`);
}

const sample = new Date('2024-06-14T20:00:00.000Z'); // 01:30 IST next day? 20:00 UTC = 01:30 IST Jun 15
// 20:00 UTC = 01:30 IST on Jun 15
if (zonedYmd(sample, tz) !== '2024-06-15') throw new Error(`ymd ${zonedYmd(sample, tz)}`);
if (zonedHourKey(sample, tz) !== '2024-06-15T01') {
  throw new Error(`hour ${zonedHourKey(sample, tz)}`);
}

const { start, end, mode } = resolveGrowthWindow('today', tz);
if (mode !== 'hour') throw new Error('today should be hour');
if (!(start <= new Date() && end >= start)) throw new Error('today window');

const buckets = buildGrowthBuckets(
  [{ createdAt: sample }],
  wallTimeToUtc(tz, 2024, 6, 15, 0, 0, 0, 0),
  wallTimeToUtc(tz, 2024, 6, 15, 23, 59, 59, 999),
  'hour',
  tz
);
const hit = buckets.find((b) => b.date === '2024-06-15T01');
if (!hit || hit.count !== 1) throw new Error(`bucket miss ${JSON.stringify(hit)}`);
if (hit.label !== '01:00') throw new Error(`label ${hit.label}`);

console.log('contactGrowth.check.ts: ok');
