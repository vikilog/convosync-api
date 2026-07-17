import { prisma } from '../index.js';
import { isSuperAdminWorkspace } from './superAdminWorkspace.js';

const DEFAULT_LIMITS = {
  aiAgentsLimit: 1,
  channelsLimit: 2,
  emailsLimit: 1000,
} as const;

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
  return limit >= Number.MAX_SAFE_INTEGER;
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
    throw new Error(
      `AI agent limit reached (${aiAgentsLimit}). Upgrade your plan to create more AI agents.`
    );
  }
}

export async function assertChannelCreateAllowed(_workspaceId: string, _increment = 1) {
  // ponytail: channel connect caps disabled (was plan channelsLimit, default 2). Re-enable by restoring the usage check.
}

export async function assertEmailSendAllowed(workspaceId: string, sendCount = 1) {
  if (await isSuperAdminWorkspace(workspaceId)) return;

  const [{ emailsLimit }, sentCountThisMonth] = await Promise.all([
    getLimitSnapshot(workspaceId),
    countSentEmailsThisMonth(workspaceId),
  ]);

  if (isUnlimited(emailsLimit)) return;
  if (sentCountThisMonth + Math.max(1, sendCount) > emailsLimit) {
    throw new Error(
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

