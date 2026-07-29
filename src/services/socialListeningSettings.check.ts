/**
 * ponytail: tiny self-check for working-hours helpers (no test framework).
 * Run: npx tsx src/services/socialListeningSettings.check.ts
 */
import {
  decideAutomationAction,
  isWithinWorkingHours,
  parseHhMm,
  shouldCreateLeadForIntent,
  type SocialListeningSettingsPublic,
} from './socialListeningSettings.service.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(parseHhMm('09:00') === 9 * 60, 'parse 09:00');
assert(parseHhMm('18:30') === 18 * 60 + 30, 'parse 18:30');
assert(parseHhMm('25:00') == null, 'reject bad hour');

assert(
  isWithinWorkingHours({
    workingHoursOnly: false,
    workingHoursStart: '09:00',
    workingHoursEnd: '17:00',
    timeZone: 'UTC',
    now: new Date('2026-07-28T03:00:00Z'),
  }),
  'disabled hours always ok'
);

assert(
  isWithinWorkingHours({
    workingHoursOnly: true,
    workingHoursStart: '09:00',
    workingHoursEnd: '17:00',
    timeZone: 'UTC',
    now: new Date('2026-07-28T12:00:00Z'),
  }),
  'noon UTC inside 09-17'
);

assert(
  !isWithinWorkingHours({
    workingHoursOnly: true,
    workingHoursStart: '09:00',
    workingHoursEnd: '17:00',
    timeZone: 'UTC',
    now: new Date('2026-07-28T20:00:00Z'),
  }),
  '20:00 UTC outside 09-17'
);

assert(shouldCreateLeadForIntent('never', 'interested') === false, 'never');
assert(shouldCreateLeadForIntent('interested_only', 'question') === false, 'interested_only');
assert(shouldCreateLeadForIntent('interested_and_questions', 'question') === true, 'q ok');

const base: SocialListeningSettingsPublic = {
  id: 'x',
  workspaceId: 'w',
  autoResponseEnabled: false,
  leadFunnelId: 'fun_1',
  interestedMode: 'auto',
  questionMode: 'review',
  complaintMode: 'review',
  spamMode: 'review',
  confidenceThreshold: 80,
  publicReplyTone: 'friendly',
  dmAgentSkillId: null,
  fallbackMessage: null,
  leadCreationRule: 'interested_only',
  maxAutoDmsPerDay: 50,
  workingHoursOnly: false,
  workingHoursStart: null,
  workingHoursEnd: null,
  updatedAt: new Date().toISOString(),
  autoDmsSentToday: 0,
};

assert(
  decideAutomationAction({
    settings: base,
    intent: 'interested',
    confidence: 0.99,
    timeZone: 'UTC',
    autoDmsSentToday: 0,
  }).action === 'review',
  'master off → review'
);

assert(
  decideAutomationAction({
    settings: { ...base, autoResponseEnabled: true, leadFunnelId: null },
    intent: 'interested',
    confidence: 0.9,
    timeZone: 'UTC',
    autoDmsSentToday: 0,
  }).action === 'review',
  'no funnel → review'
);

assert(
  decideAutomationAction({
    settings: { ...base, autoResponseEnabled: true },
    intent: 'interested',
    confidence: 0.9,
    timeZone: 'UTC',
    autoDmsSentToday: 0,
  }).action === 'auto_dm',
  'auto + high conf → auto_dm'
);

assert(
  decideAutomationAction({
    settings: { ...base, autoResponseEnabled: true, complaintMode: 'escalate_only' },
    intent: 'complaint',
    confidence: 0.99,
    timeZone: 'UTC',
    autoDmsSentToday: 0,
  }).action === 'escalate',
  'complaint escalate'
);

assert(
  decideAutomationAction({
    settings: { ...base, autoResponseEnabled: true },
    intent: 'interested',
    confidence: 0.5,
    timeZone: 'UTC',
    autoDmsSentToday: 0,
  }).action === 'review',
  'below threshold → review'
);

console.log('socialListeningSettings.check: ok');
