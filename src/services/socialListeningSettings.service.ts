import { prisma } from '../index.js';
import { logSocialListeningActivity } from './socialListeningActivity.service.js';
import { automationAllowed } from './leadFunnel.gate.js';
import { assertFunnelInWorkspace } from './leadFunnel.service.js';

export const INTERESTED_MODES = ['auto', 'review', 'off'] as const;
export const QUESTION_MODES = ['auto', 'review', 'off'] as const;
export const COMPLAINT_MODES = ['review', 'escalate_only'] as const;
export const SPAM_MODES = ['auto_ignore', 'review'] as const;
export const REPLY_TONES = ['friendly', 'professional', 'playful'] as const;
export const LEAD_RULES = [
  'interested_only',
  'interested_and_questions',
  'never',
] as const;

export type InterestedMode = (typeof INTERESTED_MODES)[number];
export type QuestionMode = (typeof QUESTION_MODES)[number];
export type ComplaintMode = (typeof COMPLAINT_MODES)[number];
export type SpamMode = (typeof SPAM_MODES)[number];
export type ReplyTone = (typeof REPLY_TONES)[number];
export type LeadCreationRule = (typeof LEAD_RULES)[number];

export type SocialListeningSettingsPublic = {
  id: string;
  workspaceId: string;
  autoResponseEnabled: boolean;
  leadFunnelId: string | null;
  interestedMode: InterestedMode;
  questionMode: QuestionMode;
  complaintMode: ComplaintMode;
  spamMode: SpamMode;
  confidenceThreshold: number;
  publicReplyTone: ReplyTone;
  dmAgentSkillId: string | null;
  fallbackMessage: string | null;
  leadCreationRule: LeadCreationRule;
  maxAutoDmsPerDay: number;
  workingHoursOnly: boolean;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;
  updatedAt: string;
  autoDmsSentToday: number;
};

export type AutoDecision =
  | { action: 'review'; reason: string }
  | { action: 'ignore'; reason: string }
  | { action: 'escalate'; reason: string }
  | { action: 'auto_dm'; reason: string };

function inEnum<T extends string>(val: unknown, allowed: readonly T[]): val is T {
  return typeof val === 'string' && (allowed as readonly string[]).includes(val);
}

/** Parse HH:mm → minutes from midnight, or null if invalid. */
export function parseHhMm(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Current HH:mm minutes in IANA timezone (falls back to UTC). */
export function minutesNowInTz(timeZone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** Start of calendar day in timezone as Date (UTC instant). */
export function startOfDayInTz(timeZone: string, now = new Date()): Date {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const ymd = dtf.format(now); // YYYY-MM-DD
    // Approximate: interpret midnight local via iterative offset — good enough for daily caps.
    const probe = new Date(`${ymd}T12:00:00.000Z`);
    const localParts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(probe);
    const localHour = Number(localParts.find((p) => p.type === 'hour')?.value ?? '12');
    const localMin = Number(localParts.find((p) => p.type === 'minute')?.value ?? '0');
    const localMinutesAtNoonUtc = localHour * 60 + localMin;
    // At UTC noon of that calendar guess, local clock shows localMinutesAtNoonUtc.
    // Midnight local = probe - localMinutes * 60s.
    return new Date(probe.getTime() - localMinutesAtNoonUtc * 60_000);
  } catch {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

export function isWithinWorkingHours(opts: {
  workingHoursOnly: boolean;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;
  timeZone: string;
  now?: Date;
}): boolean {
  if (!opts.workingHoursOnly) return true;
  const start = parseHhMm(opts.workingHoursStart);
  const end = parseHhMm(opts.workingHoursEnd);
  if (start == null || end == null) return true; // misconfigured → don't block
  const nowMin = minutesNowInTz(opts.timeZone, opts.now);
  if (start <= end) return nowMin >= start && nowMin < end;
  // overnight window e.g. 22:00–06:00
  return nowMin >= start || nowMin < end;
}

export function toPublicSettings(
  row: {
    id: string;
    workspaceId: string;
    autoResponseEnabled: boolean;
    leadFunnelId?: string | null;
    interestedMode: string;
    questionMode: string;
    complaintMode: string;
    spamMode: string;
    confidenceThreshold: number;
    publicReplyTone: string;
    dmAgentSkillId: string | null;
    fallbackMessage: string | null;
    leadCreationRule: string;
    maxAutoDmsPerDay: number;
    workingHoursOnly: boolean;
    workingHoursStart: string | null;
    workingHoursEnd: string | null;
    updatedAt: Date;
  },
  autoDmsSentToday: number
): SocialListeningSettingsPublic {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    autoResponseEnabled: row.autoResponseEnabled,
    leadFunnelId: row.leadFunnelId ?? null,
    interestedMode: (inEnum(row.interestedMode, INTERESTED_MODES)
      ? row.interestedMode
      : 'review') as InterestedMode,
    questionMode: (inEnum(row.questionMode, QUESTION_MODES)
      ? row.questionMode
      : 'review') as QuestionMode,
    complaintMode: (inEnum(row.complaintMode, COMPLAINT_MODES)
      ? row.complaintMode
      : 'review') as ComplaintMode,
    spamMode: (inEnum(row.spamMode, SPAM_MODES) ? row.spamMode : 'review') as SpamMode,
    confidenceThreshold: row.confidenceThreshold,
    publicReplyTone: (inEnum(row.publicReplyTone, REPLY_TONES)
      ? row.publicReplyTone
      : 'friendly') as ReplyTone,
    dmAgentSkillId: row.dmAgentSkillId,
    fallbackMessage: row.fallbackMessage,
    leadCreationRule: (inEnum(row.leadCreationRule, LEAD_RULES)
      ? row.leadCreationRule
      : 'interested_only') as LeadCreationRule,
    maxAutoDmsPerDay: row.maxAutoDmsPerDay,
    workingHoursOnly: row.workingHoursOnly,
    workingHoursStart: row.workingHoursStart,
    workingHoursEnd: row.workingHoursEnd,
    updatedAt: row.updatedAt.toISOString(),
    autoDmsSentToday,
  };
}

export async function countAutoDmsSentToday(
  workspaceId: string,
  timeZone: string,
  now = new Date()
): Promise<number> {
  const since = startOfDayInTz(timeZone, now);
  return prisma.socialComment.count({
    where: {
      workspaceId,
      dmStatus: 'sent',
      dmSentAt: { gte: since },
    },
  });
}

/** Auto-DMs sent today for one Instagram post (media id). */
export async function countAutoDmsSentTodayForPost(
  workspaceId: string,
  postId: string,
  timeZone: string,
  now = new Date()
): Promise<number> {
  const since = startOfDayInTz(timeZone, now);
  return prisma.socialComment.count({
    where: {
      workspaceId,
      postId,
      dmStatus: 'sent',
      dmSentAt: { gte: since },
    },
  });
}

export async function getOrCreateSocialListeningSettings(
  workspaceId: string
): Promise<SocialListeningSettingsPublic> {
  let row = await prisma.socialListeningSettings.findUnique({
    where: { workspaceId },
  });
  if (!row) {
    row = await prisma.socialListeningSettings.create({
      data: { workspaceId },
    });
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  const tz = workspace?.timezone || 'Asia/Kolkata';
  const autoDmsSentToday = await countAutoDmsSentToday(workspaceId, tz);
  return toPublicSettings(row, autoDmsSentToday);
}

export type SettingsPatch = {
  autoResponseEnabled?: boolean;
  leadFunnelId?: string | null;
  interestedMode?: string;
  questionMode?: string;
  complaintMode?: string;
  spamMode?: string;
  confidenceThreshold?: number;
  publicReplyTone?: string;
  dmAgentSkillId?: string | null;
  fallbackMessage?: string | null;
  leadCreationRule?: string;
  maxAutoDmsPerDay?: number;
  workingHoursOnly?: boolean;
  workingHoursStart?: string | null;
  workingHoursEnd?: string | null;
};

export function validateSettingsPatch(patch: SettingsPatch): {
  ok: true;
  data: SettingsPatch;
} | { ok: false; error: string } {
  if (patch.interestedMode != null && !inEnum(patch.interestedMode, INTERESTED_MODES)) {
    return { ok: false, error: `interestedMode must be one of: ${INTERESTED_MODES.join(', ')}` };
  }
  if (patch.questionMode != null && !inEnum(patch.questionMode, QUESTION_MODES)) {
    return { ok: false, error: `questionMode must be one of: ${QUESTION_MODES.join(', ')}` };
  }
  if (patch.complaintMode != null) {
    if (patch.complaintMode === 'auto') {
      return { ok: false, error: 'complaintMode cannot be "auto" — use review or escalate_only' };
    }
    if (!inEnum(patch.complaintMode, COMPLAINT_MODES)) {
      return {
        ok: false,
        error: `complaintMode must be one of: ${COMPLAINT_MODES.join(', ')}`,
      };
    }
  }
  if (patch.spamMode != null && !inEnum(patch.spamMode, SPAM_MODES)) {
    return { ok: false, error: `spamMode must be one of: ${SPAM_MODES.join(', ')}` };
  }
  if (patch.publicReplyTone != null && !inEnum(patch.publicReplyTone, REPLY_TONES)) {
    return { ok: false, error: `publicReplyTone must be one of: ${REPLY_TONES.join(', ')}` };
  }
  if (patch.leadCreationRule != null && !inEnum(patch.leadCreationRule, LEAD_RULES)) {
    return { ok: false, error: `leadCreationRule must be one of: ${LEAD_RULES.join(', ')}` };
  }
  if (patch.confidenceThreshold != null) {
    const n = Number(patch.confidenceThreshold);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return { ok: false, error: 'confidenceThreshold must be an integer 0–100' };
    }
  }
  if (patch.maxAutoDmsPerDay != null) {
    const n = Number(patch.maxAutoDmsPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) {
      return { ok: false, error: 'maxAutoDmsPerDay must be an integer 0–10000' };
    }
  }
  if (patch.fallbackMessage != null && patch.fallbackMessage.length > 1000) {
    return { ok: false, error: 'fallbackMessage must be 1000 characters or fewer' };
  }
  if (patch.dmAgentSkillId != null && patch.dmAgentSkillId.length > 100) {
    return { ok: false, error: 'dmAgentSkillId is invalid' };
  }
  if (patch.workingHoursStart != null && patch.workingHoursStart !== '') {
    if (parseHhMm(patch.workingHoursStart) == null) {
      return { ok: false, error: 'workingHoursStart must be HH:mm' };
    }
  }
  if (patch.workingHoursEnd != null && patch.workingHoursEnd !== '') {
    if (parseHhMm(patch.workingHoursEnd) == null) {
      return { ok: false, error: 'workingHoursEnd must be HH:mm' };
    }
  }
  // leadFunnelId has a real FK constraint (SET NULL on delete) — an empty
  // string is neither a valid id nor NULL, so writing it straight through
  // would surface as a raw foreign-key-violation error instead of a clean
  // validation message. Normalize blank to null at this shared boundary
  // (used by both the workspace-level and per-post settings callers) so a
  // caller that skips the frontend's own `|| null` normalization can't hit it.
  const data: SettingsPatch = {
    ...patch,
    ...(patch.leadFunnelId !== undefined
      ? { leadFunnelId: patch.leadFunnelId?.trim() ? patch.leadFunnelId.trim() : null }
      : {}),
  };
  return { ok: true, data };
}

export async function updateSocialListeningSettings(
  workspaceId: string,
  patch: SettingsPatch
): Promise<SocialListeningSettingsPublic> {
  const validated = validateSettingsPatch(patch);
  if (!validated.ok) throw new Error(validated.error);

  const current = await getOrCreateSocialListeningSettings(workspaceId);
  const data = validated.data;

  const nextFunnelId =
    data.leadFunnelId !== undefined ? data.leadFunnelId : current.leadFunnelId;
  const nextAuto =
    data.autoResponseEnabled !== undefined
      ? data.autoResponseEnabled
      : current.autoResponseEnabled;

  if (data.leadFunnelId) {
    if (!(await assertFunnelInWorkspace(workspaceId, data.leadFunnelId))) {
      throw new Error('Lead funnel not found — create a funnel under Leads first');
    }
  }

  if (nextAuto && !automationAllowed(nextFunnelId)) {
    throw new Error(
      'Select a lead funnel before enabling automation (create one under Leads first)'
    );
  }

  const row = await prisma.socialListeningSettings.update({
    where: { workspaceId },
    data: {
      ...(data.autoResponseEnabled !== undefined
        ? { autoResponseEnabled: data.autoResponseEnabled }
        : {}),
      ...(data.leadFunnelId !== undefined ? { leadFunnelId: data.leadFunnelId } : {}),
      ...(data.interestedMode !== undefined ? { interestedMode: data.interestedMode } : {}),
      ...(data.questionMode !== undefined ? { questionMode: data.questionMode } : {}),
      ...(data.complaintMode !== undefined ? { complaintMode: data.complaintMode } : {}),
      ...(data.spamMode !== undefined ? { spamMode: data.spamMode } : {}),
      ...(data.confidenceThreshold !== undefined
        ? { confidenceThreshold: data.confidenceThreshold }
        : {}),
      ...(data.publicReplyTone !== undefined ? { publicReplyTone: data.publicReplyTone } : {}),
      ...(data.dmAgentSkillId !== undefined ? { dmAgentSkillId: data.dmAgentSkillId } : {}),
      ...(data.fallbackMessage !== undefined ? { fallbackMessage: data.fallbackMessage } : {}),
      ...(data.leadCreationRule !== undefined ? { leadCreationRule: data.leadCreationRule } : {}),
      ...(data.maxAutoDmsPerDay !== undefined ? { maxAutoDmsPerDay: data.maxAutoDmsPerDay } : {}),
      ...(data.workingHoursOnly !== undefined ? { workingHoursOnly: data.workingHoursOnly } : {}),
      ...(data.workingHoursStart !== undefined
        ? { workingHoursStart: data.workingHoursStart || null }
        : {}),
      ...(data.workingHoursEnd !== undefined
        ? { workingHoursEnd: data.workingHoursEnd || null }
        : {}),
    },
  });

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  const tz = workspace?.timezone || 'Asia/Kolkata';
  const autoDmsSentToday = await countAutoDmsSentToday(workspaceId, tz);
  return toPublicSettings(row, autoDmsSentToday);
}

export function shouldCreateLeadForIntent(
  rule: LeadCreationRule | string,
  intent: string | null | undefined
): boolean {
  if (rule === 'never') return false;
  if (rule === 'interested_and_questions') {
    return intent === 'interested' || intent === 'question';
  }
  // interested_only (default)
  return intent === 'interested';
}

/**
 * Decide what automation should do after a comment is classified.
 * Safe default: review (leave status=new) when master toggle is off.
 */
export function decideAutomationAction(input: {
  settings: SocialListeningSettingsPublic;
  intent: string | null;
  confidence: number | null;
  timeZone: string;
  autoDmsSentToday: number;
  now?: Date;
}): AutoDecision {
  const { settings, intent, confidence } = input;

  if (!settings.autoResponseEnabled) {
    return { action: 'review', reason: 'autoResponseEnabled=false' };
  }

  if (!automationAllowed(settings.leadFunnelId)) {
    return { action: 'review', reason: 'leadFunnelId_missing' };
  }

  if (!intent || confidence == null) {
    return { action: 'review', reason: 'missing_intent_or_confidence' };
  }

  if (intent === 'unclear') {
    return { action: 'review', reason: 'intent=unclear' };
  }

  if (intent === 'complaint') {
    if (settings.complaintMode === 'escalate_only') {
      return { action: 'escalate', reason: 'complaintMode=escalate_only' };
    }
    return { action: 'review', reason: 'complaintMode=review' };
  }

  if (intent === 'spam') {
    if (settings.spamMode === 'auto_ignore') {
      return { action: 'ignore', reason: 'spamMode=auto_ignore' };
    }
    return { action: 'review', reason: 'spamMode=review' };
  }

  const mode =
    intent === 'interested'
      ? settings.interestedMode
      : intent === 'question'
        ? settings.questionMode
        : 'review';

  if (mode === 'off') {
    return { action: 'ignore', reason: `${intent}Mode=off` };
  }
  if (mode === 'review') {
    return { action: 'review', reason: `${intent}Mode=review` };
  }

  // mode === auto
  const confPct = Math.round(confidence * 100);
  if (confPct < settings.confidenceThreshold) {
    return {
      action: 'review',
      reason: `confidence ${confPct}% < threshold ${settings.confidenceThreshold}%`,
    };
  }

  if (
    !isWithinWorkingHours({
      workingHoursOnly: settings.workingHoursOnly,
      workingHoursStart: settings.workingHoursStart,
      workingHoursEnd: settings.workingHoursEnd,
      timeZone: input.timeZone,
      now: input.now,
    })
  ) {
    return { action: 'review', reason: 'outside_working_hours' };
  }

  if (input.autoDmsSentToday >= settings.maxAutoDmsPerDay) {
    return {
      action: 'review',
      reason: `maxAutoDmsPerDay reached (${input.autoDmsSentToday}/${settings.maxAutoDmsPerDay})`,
    };
  }

  return {
    action: 'auto_dm',
    reason: `${intent}Mode=auto confidence=${confPct}%>=${settings.confidenceThreshold}%`,
  };
}

/** Apply post-classify automation (ignore / escalate / auto DM). */
export async function applySocialListeningAutomation(input: {
  workspaceId: string;
  socialCommentId: string;
  intent: string | null;
  confidence: number | null;
}): Promise<AutoDecision> {
  const comment = await prisma.socialComment.findFirst({
    where: { id: input.socialCommentId, workspaceId: input.workspaceId },
    select: { postId: true },
  });
  if (!comment) {
    return { action: 'review', reason: 'comment_not_found' };
  }

  const { getEffectivePostSettings } = await import('./socialListeningPostSetting.service.js');
  const settings = await getEffectivePostSettings(input.workspaceId, comment.postId);
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { timezone: true },
  });
  const timeZone = workspace?.timezone || 'Asia/Kolkata';
  const autoDmsSentToday = settings.autoDmsSentToday;

  const decision = decideAutomationAction({
    settings,
    intent: input.intent,
    confidence: input.confidence,
    timeZone,
    autoDmsSentToday,
  });

  console.info('[social.automation] decision', {
    workspaceId: input.workspaceId,
    socialCommentId: input.socialCommentId,
    postId: comment.postId,
    intent: input.intent,
    confidence: input.confidence,
    action: decision.action,
    reason: decision.reason,
    autoResponseEnabled: settings.autoResponseEnabled,
    leadFunnelId: settings.leadFunnelId,
  });

  if (decision.action === 'review') return decision;

  if (decision.action === 'ignore') {
    await prisma.socialComment.update({
      where: { id: input.socialCommentId },
      data: { status: 'ignored' },
    });
    await logSocialListeningActivity({
      workspaceId: input.workspaceId,
      eventType: 'auto_ignore',
      message: `Auto-ignored comment (${input.intent || 'unknown'}) — ${decision.reason}`,
      relatedCommentId: input.socialCommentId,
      meta: { intent: input.intent, confidence: input.confidence, reason: decision.reason },
    });
    return decision;
  }

  if (decision.action === 'escalate') {
    await prisma.socialComment.update({
      where: { id: input.socialCommentId },
      data: { status: 'escalated' },
    });
    await logSocialListeningActivity({
      workspaceId: input.workspaceId,
      eventType: 'auto_escalate',
      message: `Auto-escalated complaint — ${decision.reason}`,
      relatedCommentId: input.socialCommentId,
      meta: { intent: input.intent, confidence: input.confidence, reason: decision.reason },
    });
    return decision;
  }

  // auto_dm — lazy import to avoid circular deps at module load
  const { executeApproveAndSendDm } = await import('./socialCommentApproveDm.service.js');
  try {
    const result = await executeApproveAndSendDm({
      workspaceId: input.workspaceId,
      socialCommentId: input.socialCommentId,
      source: 'auto',
    });
    console.info('[social.automation] auto_dm completed', {
      socialCommentId: input.socialCommentId,
      reason: decision.reason,
      dmStatus: result.dmStatus,
    });
  } catch (err) {
    console.warn('[social.automation] auto_dm failed — left for review', {
      socialCommentId: input.socialCommentId,
      error: err instanceof Error ? err.message : err,
    });
    return { action: 'review', reason: `auto_dm_failed:${err instanceof Error ? err.message : 'error'}` };
  }

  return decision;
}
