import type { Contact } from '@prisma/client';
import { resolveContactChannel } from '../../../lib/channelContact.js';
import type {
  Condition,
  ConditionNodeData,
  ConditionOperator,
} from '../types/journey.types.js';
import { normalizeConditionGroup } from '../types/journey.types.js';
import { resolveContactField } from './message-renderer.service.js';
import { isWithinBusinessHours, type BusinessHoursConfig } from './businessHours.service.js';
import type { ContactActivity } from './contact-activity.service.js';

/** Injected by the caller so this module stays channel-agnostic (WA has no follow API / DB access). */
export type ConditionEvalContext = {
  checkFollowsBusiness?: (contact: Contact) => Promise<boolean>;
  /** Backs Last Interaction / Last Seen / Last Reply Type / Messaging window fields. */
  getContactActivity?: (contact: Contact) => Promise<ContactActivity | null>;
  /** Workspace timezone for the "Current time" condition — only fetched when needed. */
  getTimezone?: () => Promise<string>;
  /** Injectable clock for tests; defaults to `new Date()`. */
  now?: Date;
};

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function compareValues(left: unknown, operator: ConditionOperator, right: string | number): boolean {
  const leftStr = left == null ? '' : String(left);
  const rightStr = String(right);

  switch (operator) {
    case '=':
      return leftStr === rightStr;
    case '!=':
      return leftStr !== rightStr;
    case 'contains':
      return leftStr.toLowerCase().includes(rightStr.toLowerCase());
    case '>':
    case '<': {
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (ln == null || rn == null) return false;
      return operator === '>' ? ln > rn : ln < rn;
    }
    default:
      return false;
  }
}

/** `value` truthy/'yes' → wanted true; 'no'/falsy → wanted false. */
function wantsYes(value: string | number): boolean {
  return String(value).trim().toLowerCase() !== 'no';
}

function readCustomField(contact: Contact, key: string): string | undefined {
  return (contact.customFields as Record<string, string> | null)?.[key];
}

/** `null` (never messaged) sorts as "infinitely long ago" so ">" N days still reads true. */
function daysSince(date: Date | null, now: Date): number {
  if (!date) return Number.POSITIVE_INFINITY;
  return (now.getTime() - date.getTime()) / 86_400_000;
}

/** Meta messaging-window tag that would currently apply to a RESPONSE send. */
function messagingWindowSegment(lastInboundAt: Date | null, now: Date): string {
  const days = daysSince(lastInboundAt, now);
  if (days <= 1) return 'within_24h';
  if (days <= 7) return 'within_7d';
  return 'expired';
}

/**
 * Resolves the "System Fields" preset condition values. Contact-level fields (name/email/
 * phone/id) read straight off the Contact row; Instagram fields read the profile snapshot
 * already cached in `customFields` by the IG profile-refresh flow (instagramProfile.ts);
 * activity fields (last interaction/seen/reply type/window) need one memoized DB round trip.
 */
async function resolveSystemField(
  contact: Contact,
  field: string,
  ctx: ConditionEvalContext,
  now: Date
): Promise<unknown> {
  switch (field) {
    case 'firstName':
      return contact.name.trim().split(/\s+/)[0] ?? '';
    case 'lastName':
      return contact.name.trim().split(/\s+/).slice(1).join(' ');
    case 'fullName':
      return contact.name;
    case 'email':
      return contact.email ?? '';
    case 'phone':
      return contact.phone;
    case 'id':
      return contact.id;
    case 'lastReplyType':
      return (await ctx.getContactActivity?.(contact))?.lastInboundType ?? '';
    case 'ig.followerCount':
      return readCustomField(contact, 'instagramFollowerCount') ?? '';
    case 'ig.username':
      return readCustomField(contact, 'instagramUsername') ?? '';
    case 'ig.verified':
      return readCustomField(contact, 'instagramVerified') === 'yes' ? 'yes' : 'no';
    case 'ig.businessFollowsContact':
      return readCustomField(contact, 'instagramBusinessFollowsUser') === 'yes' ? 'yes' : 'no';
    case 'ig.lastInteractionDays':
      return daysSince((await ctx.getContactActivity?.(contact))?.lastInboundAt ?? null, now);
    case 'ig.lastSeenDays':
      return daysSince((await ctx.getContactActivity?.(contact))?.lastActivityAt ?? null, now);
    case 'ig.messagingWindow':
      return messagingWindowSegment((await ctx.getContactActivity?.(contact))?.lastInboundAt ?? null, now);
    default:
      return undefined;
  }
}

async function evaluateSingle(
  contact: Contact,
  cond: Condition,
  ctx: ConditionEvalContext,
  now: Date
): Promise<boolean> {
  switch (cond.type ?? 'field') {
    case 'tag': {
      const has = contact.tags.includes(String(cond.value));
      return cond.operator === '!=' ? !has : has;
    }
    case 'email_known':
      return Boolean(contact.email?.trim()) === wantsYes(cond.value);
    case 'phone_known': {
      // Contact.phone always has a value; for IG/Messenger contacts it holds a synthetic
      // ig:/fb: id rather than a real phone number, so "known" means a real number exists.
      const channel = resolveContactChannel(contact);
      const known = channel === 'whatsapp' && contact.phone.trim() !== '';
      return known === wantsYes(cond.value);
    }
    case 'follows_account': {
      // No IG credentials/consent context (e.g. WhatsApp journeys) → fail-closed "no".
      if (!ctx.checkFollowsBusiness) return false;
      const follows = await ctx.checkFollowsBusiness(contact);
      return follows === wantsYes(cond.value);
    }
    case 'custom_field':
      return compareValues(resolveContactField(contact, `custom.${cond.field}`), cond.operator, cond.value);
    case 'channel':
      return compareValues(resolveContactChannel(contact), cond.operator, cond.value);
    case 'journey_status':
      return compareValues(resolveContactField(contact, 'journeyStatus'), cond.operator, cond.value);
    case 'system_field':
      return compareValues(await resolveSystemField(contact, cond.field, ctx, now), cond.operator, cond.value);
    case 'current_time': {
      // No timezone context (e.g. not wired by caller) → fail-closed "no match".
      if (!ctx.getTimezone) return false;
      let config: BusinessHoursConfig;
      try {
        config = JSON.parse(String(cond.value || '{}')) as BusinessHoursConfig;
      } catch {
        config = {};
      }
      const timezone = await ctx.getTimezone();
      const within = isWithinBusinessHours(now, { ...config, enabled: true }, timezone);
      return cond.operator === '!=' ? !within : within;
    }
    case 'field':
    default:
      return compareValues(resolveContactField(contact, cond.field), cond.operator, cond.value);
  }
}

/**
 * Evaluate a CONDITION node's full group (1..n rows) against a contact.
 * `combinator: 'all'` = AND (every row must match), `'any'` = OR (one row is enough).
 * Short-circuits so unnecessary Graph API calls (follows_account) are skipped once the
 * outcome is already decided.
 */
export async function evaluateCondition(
  contact: Contact,
  data: ConditionNodeData,
  ctx: ConditionEvalContext = {}
): Promise<boolean> {
  const { conditions, combinator } = normalizeConditionGroup(data);
  if (conditions.length === 0) return false;

  const now = ctx.now ?? new Date();
  // Memoize per-evaluation: several rows (last interaction, last seen, messaging window,
  // last reply type) can all read the same activity lookup — fetch it at most once.
  let activityPromise: Promise<ContactActivity | null> | undefined;
  const memoizedCtx: ConditionEvalContext = ctx.getContactActivity
    ? { ...ctx, getContactActivity: (c) => (activityPromise ??= ctx.getContactActivity!(c)) }
    : ctx;

  if (combinator === 'any') {
    for (const cond of conditions) {
      if (await evaluateSingle(contact, cond, memoizedCtx, now)) return true;
    }
    return false;
  }
  for (const cond of conditions) {
    if (!(await evaluateSingle(contact, cond, memoizedCtx, now))) return false;
  }
  return true;
}

export function pickBranchEdge<T extends { conditionValue: string | null }>(
  edges: T[],
  result: boolean
): T | undefined {
  const branch = result ? 'yes' : 'no';
  return (
    edges.find((e) => e.conditionValue === branch) ??
    edges.find((e) => e.conditionValue === 'default' || e.conditionValue == null)
  );
}
