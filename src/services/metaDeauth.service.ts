import { prisma } from '../index.js';
import {
  disconnectInstagramAccounts,
  disconnectMessengerAccounts,
  type ChannelDisconnectCleanupResult,
} from './channelDisconnectCleanup.service.js';
import { purgeWhatsAppPhoneAccountData } from './whatsappDisconnectCleanup.service.js';

export type MetaDeauthCleanupResult = {
  metaUserId: string;
  instagramAccounts: number;
  messengerAccounts: number;
  whatsappAccounts: number;
  cleanup: ChannelDisconnectCleanupResult;
};

function emptyCleanup(): ChannelDisconnectCleanupResult {
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

/**
 * Meta deauthorize / data-deletion callback: remove channel accounts and inbox data
 * for the Facebook user who revoked app access.
 */
export async function purgeMetaUserChannelData(
  metaUserId: string
): Promise<MetaDeauthCleanupResult> {
  const [instagramAccounts, messengerAccounts, whatsappAccounts] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { metaUserId } }),
    prisma.messengerAccount.findMany({ where: { metaUserId } }),
    prisma.whatsAppPhoneAccount.findMany({ where: { metaUserId } }),
  ]);

  let cleanup = emptyCleanup();
  const handledInstagram = new Set<string>();

  for (const account of instagramAccounts) {
    const key = `${account.workspaceId}:${account.instagramUserId}`;
    if (handledInstagram.has(key)) continue;
    handledInstagram.add(key);
    cleanup = mergeCleanup(
      cleanup,
      await disconnectInstagramAccounts(account.workspaceId, {
        instagramUserId: account.instagramUserId,
      })
    );
  }

  for (const account of messengerAccounts) {
    const stillConnectedOnInstagram = await prisma.instagramAccount.findFirst({
      where: { workspaceId: account.workspaceId, pageId: account.pageId },
      select: { id: true },
    });
    if (stillConnectedOnInstagram) continue;

    cleanup = mergeCleanup(
      cleanup,
      await disconnectMessengerAccounts(account.workspaceId, { pageId: account.pageId })
    );
  }

  for (const account of whatsappAccounts) {
    const workspaceCleanup = await purgeWhatsAppPhoneAccountData(account.workspaceId, {
      phoneNumberId: account.phoneNumberId,
    });
    cleanup = mergeCleanup(cleanup, workspaceCleanup);

    await prisma.whatsAppPhoneAccount.deleteMany({
      where: { workspaceId: account.workspaceId, phoneNumberId: account.phoneNumberId },
    });

    const remaining = await prisma.whatsAppPhoneAccount.findMany({
      where: { workspaceId: account.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    if (remaining.length > 0) {
      const primary = remaining[0];
      await prisma.workspace.update({
        where: { id: account.workspaceId },
        data: {
          waNumberId: primary.phoneNumberId,
          wabaId: primary.wabaId,
          waPhoneNumber: primary.phoneNumber,
        },
      });
    } else {
      await prisma.workspace.update({
        where: { id: account.workspaceId },
        data: { waNumberId: null, waToken: null, wabaId: null, waPhoneNumber: null },
      });
    }
  }

  return {
    metaUserId,
    instagramAccounts: instagramAccounts.length,
    messengerAccounts: messengerAccounts.length,
    whatsappAccounts: whatsappAccounts.length,
    cleanup,
  };
}
