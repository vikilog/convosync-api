import { prisma } from '../index.js';
import { assertFunnelInWorkspace } from './leadFunnel.service.js';
import { automationAllowed } from './leadFunnel.gate.js';
import {
  countAutoDmsSentTodayForPost,
  toPublicSettings,
  validateSettingsPatch,
  type SettingsPatch,
  type SocialListeningSettingsPublic,
} from './socialListeningSettings.service.js';

export type PostSettingsPublic = SocialListeningSettingsPublic & { postId: string };

export type PostAutomationInfo = {
  autoResponseEnabled: boolean;
  leadFunnelId: string | null;
};

const SAFE_DEFAULTS = {
  autoResponseEnabled: false,
  leadFunnelId: null as string | null,
  interestedMode: 'review',
  questionMode: 'review',
  complaintMode: 'review',
  spamMode: 'review',
  confidenceThreshold: 80,
  publicReplyTone: 'friendly',
  dmAgentSkillId: null as string | null,
  fallbackMessage: null as string | null,
  leadCreationRule: 'interested_only',
  maxAutoDmsPerDay: 50,
  workingHoursOnly: false,
  workingHoursStart: null as string | null,
  workingHoursEnd: null as string | null,
};

/** Missing row = Agent OFF. */
export async function isPostAutomationEnabled(
  workspaceId: string,
  postId: string
): Promise<boolean> {
  const row = await prisma.socialListeningPostSetting.findUnique({
    where: { workspaceId_postId: { workspaceId, postId } },
    select: { autoResponseEnabled: true },
  });
  return row?.autoResponseEnabled ?? false;
}

export async function getPostAutomationMap(
  workspaceId: string,
  postIds: string[]
): Promise<Record<string, PostAutomationInfo>> {
  const ids = [...new Set(postIds.filter(Boolean))].slice(0, 200);
  const map: Record<string, PostAutomationInfo> = {};
  for (const id of ids) {
    map[id] = { autoResponseEnabled: false, leadFunnelId: null };
  }

  if (ids.length === 0) return map;

  const rows = await prisma.socialListeningPostSetting.findMany({
    where: { workspaceId, postId: { in: ids } },
    select: { postId: true, autoResponseEnabled: true, leadFunnelId: true },
  });
  for (const row of rows) {
    map[row.postId] = {
      autoResponseEnabled: row.autoResponseEnabled,
      leadFunnelId: row.leadFunnelId,
    };
  }
  return map;
}

/** Post funnel only — no workspace fallback. */
export async function resolveLeadFunnelForPost(
  workspaceId: string,
  postId: string
): Promise<string | null> {
  const row = await prisma.socialListeningPostSetting.findUnique({
    where: { workspaceId_postId: { workspaceId, postId } },
    select: { leadFunnelId: true },
  });
  return row?.leadFunnelId ?? null;
}

async function workspaceTz(workspaceId: string): Promise<string> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  return workspace?.timezone || 'Asia/Kolkata';
}

export async function getEffectivePostSettings(
  workspaceId: string,
  postId: string
): Promise<PostSettingsPublic> {
  const tz = await workspaceTz(workspaceId);
  const autoDmsSentToday = await countAutoDmsSentTodayForPost(workspaceId, postId, tz);
  const row = await prisma.socialListeningPostSetting.findUnique({
    where: { workspaceId_postId: { workspaceId, postId } },
  });

  if (!row) {
    return {
      ...toPublicSettings(
        {
          id: `default:${postId}`,
          workspaceId,
          ...SAFE_DEFAULTS,
          updatedAt: new Date(0),
        },
        autoDmsSentToday
      ),
      postId,
    };
  }

  return {
    ...toPublicSettings(row, autoDmsSentToday),
    postId: row.postId,
  };
}

export async function updatePostSettings(
  workspaceId: string,
  postId: string,
  patch: SettingsPatch
): Promise<PostSettingsPublic> {
  if (!postId.trim()) throw new Error('postId required');

  const validated = validateSettingsPatch(patch);
  if (!validated.ok) throw new Error(validated.error);
  const data = validated.data;

  const existing = await prisma.socialListeningPostSetting.findUnique({
    where: { workspaceId_postId: { workspaceId, postId } },
  });

  const nextFunnelId =
    data.leadFunnelId !== undefined
      ? data.leadFunnelId
      : (existing?.leadFunnelId ?? null);
  const nextAuto =
    data.autoResponseEnabled !== undefined
      ? data.autoResponseEnabled
      : (existing?.autoResponseEnabled ?? false);

  if (data.leadFunnelId) {
    if (!(await assertFunnelInWorkspace(workspaceId, data.leadFunnelId))) {
      throw new Error('Lead funnel not found — create a funnel under Leads first');
    }
  }

  if (nextAuto && !automationAllowed(nextFunnelId)) {
    throw new Error(
      'Select a lead funnel before enabling the agent (create one under Leads first)'
    );
  }

  const createData = {
    workspaceId,
    postId,
    autoResponseEnabled: nextAuto,
    leadFunnelId: nextFunnelId,
    interestedMode: data.interestedMode ?? existing?.interestedMode ?? SAFE_DEFAULTS.interestedMode,
    questionMode: data.questionMode ?? existing?.questionMode ?? SAFE_DEFAULTS.questionMode,
    complaintMode: data.complaintMode ?? existing?.complaintMode ?? SAFE_DEFAULTS.complaintMode,
    spamMode: data.spamMode ?? existing?.spamMode ?? SAFE_DEFAULTS.spamMode,
    confidenceThreshold:
      data.confidenceThreshold ??
      existing?.confidenceThreshold ??
      SAFE_DEFAULTS.confidenceThreshold,
    publicReplyTone:
      data.publicReplyTone ?? existing?.publicReplyTone ?? SAFE_DEFAULTS.publicReplyTone,
    dmAgentSkillId:
      data.dmAgentSkillId !== undefined
        ? data.dmAgentSkillId
        : (existing?.dmAgentSkillId ?? null),
    fallbackMessage:
      data.fallbackMessage !== undefined
        ? data.fallbackMessage
        : (existing?.fallbackMessage ?? null),
    leadCreationRule:
      data.leadCreationRule ?? existing?.leadCreationRule ?? SAFE_DEFAULTS.leadCreationRule,
    maxAutoDmsPerDay:
      data.maxAutoDmsPerDay ?? existing?.maxAutoDmsPerDay ?? SAFE_DEFAULTS.maxAutoDmsPerDay,
    workingHoursOnly:
      data.workingHoursOnly ?? existing?.workingHoursOnly ?? SAFE_DEFAULTS.workingHoursOnly,
    workingHoursStart:
      data.workingHoursStart !== undefined
        ? data.workingHoursStart || null
        : (existing?.workingHoursStart ?? null),
    workingHoursEnd:
      data.workingHoursEnd !== undefined
        ? data.workingHoursEnd || null
        : (existing?.workingHoursEnd ?? null),
  };

  const row = await prisma.socialListeningPostSetting.upsert({
    where: { workspaceId_postId: { workspaceId, postId } },
    create: createData,
    update: {
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

  console.info('[social.post_setting]', {
    workspaceId,
    postId,
    autoResponseEnabled: row.autoResponseEnabled,
    leadFunnelId: row.leadFunnelId,
  });

  const tz = await workspaceTz(workspaceId);
  const autoDmsSentToday = await countAutoDmsSentTodayForPost(workspaceId, postId, tz);
  return { ...toPublicSettings(row, autoDmsSentToday), postId: row.postId };
}
