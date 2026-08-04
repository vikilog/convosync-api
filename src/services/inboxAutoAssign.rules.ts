/**
 * Pure helpers for inbox auto-assignment — no Prisma/IO imports.
 * Kept separate from inboxAutoAssign.service.ts so the self-check can import
 * these without pulling in conversation-assignee.service.ts's side effects.
 */
import { isWithinBusinessHours } from '../modules/journey/services/businessHours.service.js';

export type InboxAssignmentMode = 'off' | 'basic' | 'advanced';

/** `days`: 0=Sun … 6=Sat (matches Date#getDay(), same convention as journey business hours). */
export type InboxRuleBusinessHours = {
  days: number[];
  start: string;
  end: string;
  timezone?: string;
};

export type InboxRuleConditions = {
  channels?: string[];
  contactTags?: string[];
  businessHours?: InboxRuleBusinessHours;
};

export type EligibleMember = {
  membershipId: string;
  userId: string;
  assignmentLimit: number | null;
  lastAutoAssignedAt: Date | null;
  openCount: number;
};

export function withinCapacity(m: Pick<EligibleMember, 'assignmentLimit' | 'openCount'>): boolean {
  return m.assignmentLimit == null || m.openCount < m.assignmentLimit;
}

/** Does a rule's conditions match this inbound message? All configured checks must pass. */
export function ruleConditionsMatch(
  conditions: InboxRuleConditions,
  ctx: { channel: string; contactTags: string[]; now: Date; fallbackTimezone: string }
): boolean {
  if (conditions.channels?.length && !conditions.channels.includes(ctx.channel)) {
    return false;
  }
  if (conditions.contactTags?.length) {
    if (!conditions.contactTags.some((tag) => ctx.contactTags.includes(tag))) return false;
  }
  if (conditions.businessHours) {
    const bh = conditions.businessHours;
    const inWindow = isWithinBusinessHours(
      ctx.now,
      { enabled: true, startTime: bh.start, endTime: bh.end, daysOfWeek: bh.days },
      bh.timezone || ctx.fallbackTimezone
    );
    if (!inWindow) return false;
  }
  return true;
}

/** Enabled rules ordered lowest-priority-number-first (evaluated first). */
export function sortRulesForEvaluation<T extends { priority: number; enabled: boolean }>(
  rules: T[]
): T[] {
  return rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
}

/** Eligible member under their limit with the oldest (or never-assigned) lastAutoAssignedAt. */
export function pickRoundRobinCandidate(pool: EligibleMember[]): EligibleMember | null {
  const underLimit = pool.filter(withinCapacity);
  if (underLimit.length === 0) return null;
  return underLimit.reduce((oldest, m) => {
    const mTime = m.lastAutoAssignedAt?.getTime() ?? -Infinity;
    const oldestTime = oldest.lastAutoAssignedAt?.getTime() ?? -Infinity;
    return mTime < oldestTime ? m : oldest;
  });
}
