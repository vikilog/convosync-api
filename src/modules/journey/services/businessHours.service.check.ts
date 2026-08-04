import assert from 'node:assert/strict';
import {
  isWithinBusinessHours,
  nextAllowedInstant,
  resolveWaitMs,
} from './businessHours.service.js';

const cfg = {
  enabled: true,
  startTime: '09:00',
  endTime: '17:00',
  daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri
};

// 2026-07-31 is Friday — 10:00 IST should be inside
const friMorning = new Date('2026-07-31T04:30:00.000Z'); // 10:00 Asia/Kolkata
assert.equal(isWithinBusinessHours(friMorning, cfg, 'Asia/Kolkata'), true);

// 03:00 IST Friday — outside
const friNight = new Date('2026-07-30T21:30:00.000Z'); // 03:00 IST Jul 31
assert.equal(isWithinBusinessHours(friNight, cfg, 'Asia/Kolkata'), false);

const next = nextAllowedInstant(friNight, cfg, 'Asia/Kolkata');
assert.ok(isWithinBusinessHours(next, cfg, 'Asia/Kolkata'));

const wait = resolveWaitMs(0, cfg, 'Asia/Kolkata', friNight.getTime());
assert.ok(wait > 0);

assert.equal(resolveWaitMs(1000, { enabled: false }, 'UTC', Date.now()), 1000);

console.log('businessHours.service.check: ok');
