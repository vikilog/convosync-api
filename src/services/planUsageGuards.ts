import { prisma } from '../index.js';
import { isSuperAdminWorkspace } from './superAdminWorkspace.js';
import { isUnlimitedUsageLimit } from './usageLimits.js';
import {
  DEFAULT_PLAN_SEEDS,
  channelTypeAllowedByPlan,
  mediaGalleryAllowedByPlan,
  planFeatureEnabled,
  storageLimitBytesFromPlan,
  type PlanChannelKind,
  type PlanFeatures,
} from './subscriptionPlans.js';
import { getMediaGalleryUsedBytes } from '../modules/media-gallery/media-storage.js';

const DEFAULT_LIMITS = {
  aiAgentsLimit: 1,
  channelsLimit: 1,
  emailsLimit: 1000,
} as const;

const STARTER_FEATURES = DEFAULT_PLAN_SEEDS[0]!.features;

export type ChannelKind = PlanChannelKind;
export {
  channelTypeAllowedByPlan,
  mediaGalleryAllowedByPlan,
  planFeatureEnabled,
  storageLimitBytesFromPlan,
};

export type PlanFeatureFlag =
  | 'aiCopilot'
  | 'socialListening'
  | 'voiceAgent'
  | 'developers'
  | 'whatsappPay'
  | 'ctwaAds';

export class PlanGateError extends Error {
  readonly upgradePath = '/settings/subscription';

  constructor(message: string) {
    super(message);
    this.name = 'PlanGateError';
  }
}

export function planGatePayload(
  err: unknown
): { error: string; upgradePath: string } | null {
  if (err instanceof PlanGateError) {
    return { error: err.message, upgradePath: err.upgradePath };
  }
  return null;
}

type LimitSnapshot = {
  aiAgentsLimit: number;
  channelsLimit: number;
  emailsLimit: number;
};

async function getLimitSnapshot(workspaceId: string): Promise<LimitSnapshot> {
  const limits = await prisma.workspaceUsageLimits.findUnique({
    where: { workspaceId },
    select: { aiAgentsLimit: true, channelsLimit: true, emailsLimit: true },
  });
  return {
    aiAgentsLimit: limits?.aiAgentsLimit ?? DEFAULT_LIMITS.aiAgentsLimit,
    channelsLimit: limits?.channelsLimit ?? DEFAULT_LIMITS.channelsLimit,
    emailsLimit: limits?.emailsLimit ?? DEFAULT_LIMITS.emailsLimit,
  };
}

function isUnlimited(limit: number): boolean {
  return isUnlimitedUsageLimit(limit);
}

function normalizePlanFeatures(raw: unknown): PlanFeatures {
  const features = (raw && typeof raw === 'object' ? raw : {}) as PlanFeatures;
  const merged: PlanFeatures = {
    ...STARTER_FEATURES,
    ...features,
    contacts: 'Unlimited',
  };
  // ponytail: omitted storageGb on plan JSON = custom (Enterprise); don't inherit Starter's 0
  if (!('storageGb' in features)) {
    delete merged.storageGb;
  }
  return merged;
}

/** Resolve effective plan features — trial/no-plan workspaces get Starter defaults. */
export async function getWorkspacePlanFeatures(workspaceId: string): Promise<PlanFeatures> {
  if (await isSuperAdminWorkspace(workspaceId)) {
    return normalizePlanFeatures(DEFAULT_PLAN_SEEDS.at(-1)?.features ?? STARTER_FEATURES);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      plan: { select: { features: true } },
      billingSubscriptions: {
        where: { status: { in: ['active', 'authenticated', 'paused'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { plan: { select: { features: true } } },
      },
    },
  });

  const features =
    workspace?.plan?.features ??
    workspace?.billingSubscriptions[0]?.plan?.features ??
    // ponytail: trial / no-plan workspaces inherit Starter caps until checkout
    STARTER_FEATURES;

  return normalizePlanFeatures(features);
}

export async function assertPlanFeature(
  workspaceId: string,
  flag: PlanFeatureFlag
): Promise<void> {
  if (await isSuperAdminWorkspace(workspaceId)) return;
  const features = await getWorkspacePlanFeatures(workspaceId);
  if (!planFeatureEnabled(features, flag)) {
    throw new PlanGateError(
      `${featureLabel(flag)} is not included in your plan. Upgrade in Settings → Plans.`
    );
  }
}

export async function assertChannelTypeAllowed(
  workspaceId: string,
  channel: ChannelKind
): Promise<void> {
  if (await isSuperAdminWorkspace(workspaceId)) return;
  const features = await getWorkspacePlanFeatures(workspaceId);
  if (!channelTypeAllowedByPlan(features, channel)) {
    throw new PlanGateError(
      `${channelLabel(channel)} is not included in your plan (${features.channels}). Upgrade in Settings → Plans.`
    );
  }
}

export async function countConnectedChannels(workspaceId: string): Promise<number> {
  const [workspace, whatsappCount, instagramCount, messengerCount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { waNumberId: true, emailIntegrationEnabled: true },
    }),
    prisma.whatsAppPhoneAccount.count({ where: { workspaceId } }),
    prisma.instagramAccount.count({ where: { workspaceId } }),
    prisma.messengerAccount.count({ where: { workspaceId } }),
  ]);

  const effectiveWhatsAppCount = workspace?.waNumberId
    ? Math.max(whatsappCount, 1)
    : whatsappCount;
  const emailChannelCount = workspace?.emailIntegrationEnabled ? 1 : 0;

  return effectiveWhatsAppCount + instagramCount + messengerCount + emailChannelCount;
}

export async function assertAiAgentCreateAllowed(workspaceId: string, increment = 1) {
  if (await isSuperAdminWorkspace(workspaceId)) return;

  const [{ aiAgentsLimit }, existing] = await Promise.all([
    getLimitSnapshot(workspaceId),
    prisma.aiAgent.count({ where: { workspaceId } }),
  ]);

  if (isUnlimited(aiAgentsLimit)) return;
  if (existing + increment > aiAgentsLimit) {
    throw new PlanGateError(
      `AI agent limit reached (${aiAgentsLimit}). Upgrade your plan to create more AI agents.`
    );
  }
}

export async function assertChannelCreateAllowed(
  workspaceId: string,
  increment = 1,
  channel?: ChannelKind
) {
  if (channel) {
    await assertChannelTypeAllowed(workspaceId, channel);
  }

  if (await isSuperAdminWorkspace(workspaceId)) return;

  // ponytail: email allowed on all plans; send volume gated separately — not channelsLimit
  if (channel === 'email') return;

  const [{ channelsLimit }, existing] = await Promise.all([
    getLimitSnapshot(workspaceId),
    countConnectedChannels(workspaceId),
  ]);

  if (isUnlimited(channelsLimit)) return;
  if (existing + increment > channelsLimit) {
    throw new PlanGateError(
      `Channel limit reached (${channelsLimit}). Upgrade your plan to connect more channels.`
    );
  }
}

export async function assertInstagramAutomationAllowed(workspaceId: string) {
  await assertChannelTypeAllowed(workspaceId, 'instagram');
}

export async function assertMediaGalleryAllowed(workspaceId: string): Promise<void> {
  if (await isSuperAdminWorkspace(workspaceId)) return;
  const features = await getWorkspacePlanFeatures(workspaceId);
  if (!mediaGalleryAllowedByPlan(features)) {
    throw new PlanGateError(
      'Media Gallery is not included in your plan. Upgrade in Settings → Plans.'
    );
  }
}

export async function assertMediaStorageUploadAllowed(
  workspaceId: string,
  additionalBytes: number
): Promise<void> {
  await assertMediaGalleryAllowed(workspaceId);
  if (await isSuperAdminWorkspace(workspaceId)) return;

  const features = await getWorkspacePlanFeatures(workspaceId);
  const limitBytes = storageLimitBytesFromPlan(features);
  if (limitBytes == null) return;

  const usedBytes = await getMediaGalleryUsedBytes(workspaceId);
  if (usedBytes + Math.max(0, additionalBytes) > limitBytes) {
    const limitGb = features.storageGb ?? 0;
    throw new PlanGateError(
      `Media storage limit reached (${limitGb} GB). Upgrade your plan or delete files to upload more.`
    );
  }
}

export async function assertEmailSendAllowed(workspaceId: string, sendCount = 1) {
  if (await isSuperAdminWorkspace(workspaceId)) return;

  const [{ emailsLimit }, sentCountThisMonth] = await Promise.all([
    getLimitSnapshot(workspaceId),
    countSentEmailsThisMonth(workspaceId),
  ]);

  if (isUnlimited(emailsLimit)) return;
  if (sentCountThisMonth + Math.max(1, sendCount) > emailsLimit) {
    throw new PlanGateError(
      `Monthly email limit reached (${emailsLimit}). Upgrade your plan or buy add-ons to send more emails.`
    );
  }
}

function monthRange() {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

async function countSentEmailsThisMonth(workspaceId: string) {
  const { start, end } = monthRange();
  return prisma.emailLog.count({
    where: {
      workspaceId,
      status: 'sent',
      createdAt: { gte: start, lt: end },
    },
  });
}

function channelLabel(channel: ChannelKind): string {
  if (channel === 'whatsapp') return 'WhatsApp';
  if (channel === 'instagram') return 'Instagram';
  if (channel === 'messenger') return 'Messenger';
  return 'Email';
}

function featureLabel(flag: PlanFeatureFlag): string {
  switch (flag) {
    case 'aiCopilot':
      return 'AI Copilot';
    case 'socialListening':
      return 'Social Listening';
    case 'voiceAgent':
      return 'Voice Agent';
    case 'developers':
      return 'Developers';
    case 'whatsappPay':
      return 'WhatsApp Pay';
    case 'ctwaAds':
      return 'CTWA / Ads';
    default:
      return flag;
  }
}
