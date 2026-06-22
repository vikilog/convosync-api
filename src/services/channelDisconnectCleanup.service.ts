import { prisma } from '../index.js';

export type ChannelDisconnectCleanupResult = {
  conversations: number;
  messages: number;
  agentFlowSessions: number;
  journeyExecutions: number;
  journeyExecutionLogs: number;
  contacts: number;
  campaigns: number;
};

export type DisconnectChannel = 'whatsapp' | 'instagram' | 'messenger';

function emptyCleanupResult(): ChannelDisconnectCleanupResult {
  return {
    conversations: 0,
    messages: 0,
    agentFlowSessions: 0,
    journeyExecutions: 0,
    journeyExecutionLogs: 0,
    contacts: 0,
    campaigns: 0,
  };
}

function mergeCleanup(
  a: ChannelDisconnectCleanupResult,
  b: ChannelDisconnectCleanupResult
): ChannelDisconnectCleanupResult {
  return {
    conversations: a.conversations + b.conversations,
    messages: a.messages + b.messages,
    agentFlowSessions: a.agentFlowSessions + b.agentFlowSessions,
    journeyExecutions: a.journeyExecutions + b.journeyExecutions,
    journeyExecutionLogs: a.journeyExecutionLogs + b.journeyExecutionLogs,
    contacts: a.contacts + b.contacts,
    campaigns: a.campaigns + b.campaigns,
  };
}

function isWhatsAppCampaign(audienceFilter: unknown): boolean {
  if (!audienceFilter || typeof audienceFilter !== 'object') return true;
  const channel = (audienceFilter as Record<string, unknown>).channel;
  return channel === undefined || channel === 'whatsapp';
}

function isInstagramCampaign(audienceFilter: unknown): boolean {
  if (!audienceFilter || typeof audienceFilter !== 'object') return false;
  return (audienceFilter as Record<string, unknown>).channel === 'instagram';
}

async function countRemainingChannelAccounts(
  workspaceId: string,
  channel: DisconnectChannel,
  excludeAccountId?: string
): Promise<number> {
  if (channel === 'whatsapp') {
    return prisma.whatsAppPhoneAccount.count({
      where: {
        workspaceId,
        ...(excludeAccountId ? { phoneNumberId: { not: excludeAccountId } } : {}),
      },
    });
  }
  if (channel === 'instagram') {
    return prisma.instagramAccount.count({
      where: {
        workspaceId,
        ...(excludeAccountId ? { pageId: { not: excludeAccountId } } : {}),
      },
    });
  }
  return prisma.messengerAccount.count({
    where: {
      workspaceId,
      ...(excludeAccountId ? { pageId: { not: excludeAccountId } } : {}),
    },
  });
}

/**
 * Remove inbox, journey, agent session, and optional campaign data for a channel account.
 */
export async function purgeChannelAccountData(
  workspaceId: string,
  params: {
    channel: DisconnectChannel;
    channelAccountId?: string;
    removeAllForChannel?: boolean;
    orphanContactSource?: string;
    purgeCampaigns?: boolean;
  }
): Promise<ChannelDisconnectCleanupResult> {
  const { channel, channelAccountId } = params;
  const removeAll = params.removeAllForChannel ?? !channelAccountId;

  const remainingAccounts =
    channelAccountId && !removeAll
      ? await countRemainingChannelAccounts(workspaceId, channel, channelAccountId)
      : 0;

  const purgeAllChannel = removeAll || remainingAccounts === 0;

  const conversationWhere = purgeAllChannel
    ? { workspaceId, channel }
    : {
        workspaceId,
        channel,
        channelAccountId,
      };

  const conversations = await prisma.conversation.findMany({
    where: conversationWhere,
    select: { id: true, contactId: true },
  });

  const conversationIds = conversations.map((c) => c.id);
  const affectedContactIds = [...new Set(conversations.map((c) => c.contactId))];

  let messages = 0;
  let agentFlowSessions = 0;
  let journeyExecutions = 0;
  let journeyExecutionLogs = 0;
  let contacts = 0;
  let campaigns = 0;

  if (conversationIds.length > 0) {
    const msgResult = await prisma.message.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });
    messages = msgResult.count;

    const sessionResult = await prisma.agentFlowSession.deleteMany({
      where: { conversationId: { in: conversationIds } },
    });
    agentFlowSessions = sessionResult.count;

    await prisma.conversation.deleteMany({
      where: { id: { in: conversationIds } },
    });
  }

  const purgeJourneyDataForContact = async (contactId: string) => {
    const executions = await prisma.journeyExecution.findMany({
      where: { contactId, journey: { workspaceId } },
      select: { id: true },
    });
    const executionIds = executions.map((e) => e.id);
    if (executionIds.length === 0) return;

    const logResult = await prisma.journeyExecutionLog.deleteMany({
      where: { executionId: { in: executionIds } },
    });
    journeyExecutionLogs += logResult.count;

    const execResult = await prisma.journeyExecution.deleteMany({
      where: { id: { in: executionIds } },
    });
    journeyExecutions += execResult.count;
  };

  for (const contactId of affectedContactIds) {
    await purgeJourneyDataForContact(contactId);
    await prisma.agentFlowSession.deleteMany({ where: { contactId, workspaceId } });

    const remainingConversations = await prisma.conversation.count({
      where: { workspaceId, contactId },
    });
    if (remainingConversations > 0) continue;

    const deleted = await prisma.contact.deleteMany({ where: { id: contactId, workspaceId } });
    contacts += deleted.count;
  }

  if (purgeAllChannel && params.orphanContactSource) {
    const orphanContacts = await prisma.contact.findMany({
      where: {
        workspaceId,
        source: { equals: params.orphanContactSource, mode: 'insensitive' },
        conversations: { none: {} },
      },
      select: { id: true },
    });

    for (const row of orphanContacts) {
      if (affectedContactIds.includes(row.id)) continue;
      await purgeJourneyDataForContact(row.id);
      await prisma.agentFlowSession.deleteMany({ where: { contactId: row.id, workspaceId } });
      const deleted = await prisma.contact.deleteMany({ where: { id: row.id, workspaceId } });
      contacts += deleted.count;
    }
  }

  if (purgeAllChannel && params.purgeCampaigns) {
    const allCampaigns = await prisma.campaign.findMany({
      where: { workspaceId },
      select: { id: true, audienceFilter: true },
    });
    const campaignFilter =
      channel === 'instagram'
        ? isInstagramCampaign
        : channel === 'whatsapp'
          ? isWhatsAppCampaign
          : () => false;

    const campaignIds = allCampaigns.filter((c) => campaignFilter(c.audienceFilter)).map((c) => c.id);
    if (campaignIds.length > 0) {
      const campaignResult = await prisma.campaign.deleteMany({
        where: { id: { in: campaignIds }, workspaceId },
      });
      campaigns = campaignResult.count;
    }
  }

  return {
    conversations: conversationIds.length,
    messages,
    agentFlowSessions,
    journeyExecutions,
    journeyExecutionLogs,
    contacts,
    campaigns,
  };
}

export async function disconnectInstagramAccounts(
  workspaceId: string,
  filter?: { instagramUserId?: string }
): Promise<ChannelDisconnectCleanupResult> {
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      workspaceId,
      ...(filter?.instagramUserId ? { instagramUserId: filter.instagramUserId } : {}),
    },
    select: { instagramUserId: true, pageId: true },
  });

  if (accounts.length === 0) return emptyCleanupResult();

  let cleanup = emptyCleanupResult();
  for (const account of accounts) {
    cleanup = mergeCleanup(
      cleanup,
      await purgeChannelAccountData(workspaceId, {
        channel: 'instagram',
        channelAccountId: account.pageId,
        orphanContactSource: 'Instagram',
        purgeCampaigns: true,
      })
    );
    cleanup = mergeCleanup(
      cleanup,
      await purgeChannelAccountData(workspaceId, {
        channel: 'messenger',
        channelAccountId: account.pageId,
        orphanContactSource: 'Messenger',
      })
    );
    await prisma.messengerAccount.deleteMany({
      where: { workspaceId, pageId: account.pageId },
    });
  }

  await prisma.instagramAccount.deleteMany({
    where: {
      workspaceId,
      ...(filter?.instagramUserId ? { instagramUserId: filter.instagramUserId } : {}),
    },
  });

  return cleanup;
}

export async function disconnectMessengerAccounts(
  workspaceId: string,
  filter?: { pageId?: string }
): Promise<ChannelDisconnectCleanupResult> {
  const accounts = await prisma.messengerAccount.findMany({
    where: {
      workspaceId,
      ...(filter?.pageId ? { pageId: filter.pageId } : {}),
    },
    select: { pageId: true },
  });

  if (accounts.length === 0) return emptyCleanupResult();

  let cleanup = emptyCleanupResult();
  for (const account of accounts) {
    cleanup = mergeCleanup(
      cleanup,
      await purgeChannelAccountData(workspaceId, {
        channel: 'messenger',
        channelAccountId: account.pageId,
        orphanContactSource: 'Messenger',
      })
    );
  }

  await prisma.messengerAccount.deleteMany({
    where: {
      workspaceId,
      ...(filter?.pageId ? { pageId: filter.pageId } : {}),
    },
  });

  return cleanup;
}
