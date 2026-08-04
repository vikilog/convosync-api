/**
 * ponytail: tiny self-check for auto-assign pure helpers (no test framework).
 * Run: npx tsx src/services/inboxAutoAssign.check.ts
 */
import assert from 'node:assert/strict';
import {
  pickRoundRobinCandidate,
  ruleConditionsMatch,
  sortRulesForEvaluation,
  withinCapacity,
  type EligibleMember,
} from './inboxAutoAssign.rules.js';

// --- ruleConditionsMatch: channel ---
assert.equal(
  ruleConditionsMatch(
    { channels: ['whatsapp'] },
    { channel: 'instagram', contactTags: [], now: new Date(), fallbackTimezone: 'UTC' }
  ),
  false,
  'channel mismatch rejected'
);
assert.equal(
  ruleConditionsMatch(
    { channels: ['whatsapp'] },
    { channel: 'whatsapp', contactTags: [], now: new Date(), fallbackTimezone: 'UTC' }
  ),
  true,
  'channel match accepted'
);
assert.equal(
  ruleConditionsMatch({}, { channel: 'whatsapp', contactTags: [], now: new Date(), fallbackTimezone: 'UTC' }),
  true,
  'no conditions → always matches'
);

// --- ruleConditionsMatch: contact tags (any-of) ---
assert.equal(
  ruleConditionsMatch(
    { contactTags: ['vip', 'priority'] },
    { channel: 'whatsapp', contactTags: ['new_lead'], now: new Date(), fallbackTimezone: 'UTC' }
  ),
  false,
  'no overlapping tag rejected'
);
assert.equal(
  ruleConditionsMatch(
    { contactTags: ['vip', 'priority'] },
    { channel: 'whatsapp', contactTags: ['priority'], now: new Date(), fallbackTimezone: 'UTC' }
  ),
  true,
  'any-of tag match accepted'
);

// --- ruleConditionsMatch: business hours (0=Sun..6=Sat) ---
// 2026-07-31 is a Friday. 10:00 IST is inside a Mon–Fri 09:00–17:00 window.
const friMorningIst = new Date('2026-07-31T04:30:00.000Z');
assert.equal(
  ruleConditionsMatch(
    { businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'Asia/Kolkata' } },
    { channel: 'whatsapp', contactTags: [], now: friMorningIst, fallbackTimezone: 'UTC' }
  ),
  true,
  'inside business hours accepted'
);
const friNightIst = new Date('2026-07-30T21:30:00.000Z'); // 03:00 IST Friday
assert.equal(
  ruleConditionsMatch(
    { businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'Asia/Kolkata' } },
    { channel: 'whatsapp', contactTags: [], now: friNightIst, fallbackTimezone: 'UTC' }
  ),
  false,
  'outside business hours rejected'
);
// businessHours.timezone omitted → falls back to workspace/contact timezone
assert.equal(
  ruleConditionsMatch(
    { businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' } },
    { channel: 'whatsapp', contactTags: [], now: friMorningIst, fallbackTimezone: 'Asia/Kolkata' }
  ),
  true,
  'falls back to workspace timezone when rule omits one'
);

// --- sortRulesForEvaluation: lower priority number evaluates first, disabled dropped ---
const rules = [
  { id: 'c', priority: 5, enabled: true },
  { id: 'a', priority: 1, enabled: true },
  { id: 'b', priority: 2, enabled: false },
];
assert.deepEqual(
  sortRulesForEvaluation(rules).map((r) => r.id),
  ['a', 'c'],
  'sorted ascending by priority, disabled excluded'
);

// --- withinCapacity ---
assert.equal(withinCapacity({ assignmentLimit: null, openCount: 999 }), true, 'unlimited always has capacity');
assert.equal(withinCapacity({ assignmentLimit: 3, openCount: 3 }), false, 'at limit has no capacity');
assert.equal(withinCapacity({ assignmentLimit: 3, openCount: 2 }), true, 'under limit has capacity');

// --- pickRoundRobinCandidate: oldest / never-assigned first, respects limits ---
const memberA: EligibleMember = {
  membershipId: 'ma',
  userId: 'ua',
  assignmentLimit: null,
  lastAutoAssignedAt: new Date('2026-01-01T00:00:00Z'),
  openCount: 0,
};
const memberB: EligibleMember = {
  membershipId: 'mb',
  userId: 'ub',
  assignmentLimit: null,
  lastAutoAssignedAt: null, // never assigned — should win over any timestamp
  openCount: 0,
};
const memberC: EligibleMember = {
  membershipId: 'mc',
  userId: 'uc',
  assignmentLimit: 1,
  lastAutoAssignedAt: new Date('2020-01-01T00:00:00Z'), // oldest timestamp but over limit
  openCount: 1,
};
assert.equal(pickRoundRobinCandidate([memberA, memberB, memberC])?.userId, 'ub', 'never-assigned wins');
assert.equal(pickRoundRobinCandidate([memberA, memberC])?.userId, 'ua', 'over-limit member skipped');
assert.equal(pickRoundRobinCandidate([memberC]), null, 'no candidate when all over limit');
assert.equal(pickRoundRobinCandidate([]), null, 'empty pool → null');

console.log('inboxAutoAssign.check: ok');
