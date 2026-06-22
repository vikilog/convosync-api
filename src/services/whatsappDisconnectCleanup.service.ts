import { prisma } from '../index.js';
import {
  purgeChannelAccountData,
  type ChannelDisconnectCleanupResult,
} from './channelDisconnectCleanup.service.js';

export type WhatsAppDisconnectCleanupResult = ChannelDisconnectCleanupResult;

/**
 * Remove inbox, journey, agent session, and campaign data tied to a disconnected WhatsApp number.
 * When `phoneNumberId` is omitted, purges all WhatsApp channel data for the workspace.
 */
export async function purgeWhatsAppPhoneAccountData(
  workspaceId: string,
  options?: { phoneNumberId?: string; removeAllWhatsAppAccounts?: boolean }
): Promise<WhatsAppDisconnectCleanupResult> {
  const phoneNumberId = options?.phoneNumberId;
  const removeAll = options?.removeAllWhatsAppAccounts ?? !phoneNumberId;

  const remainingAccounts = await prisma.whatsAppPhoneAccount.count({
    where: {
      workspaceId,
      ...(phoneNumberId && !removeAll ? { phoneNumberId: { not: phoneNumberId } } : {}),
    },
  });

  return purgeChannelAccountData(workspaceId, {
    channel: 'whatsapp',
    channelAccountId: phoneNumberId,
    removeAllForChannel: removeAll || remainingAccounts === 0,
    orphanContactSource: 'WhatsApp',
    purgeCampaigns: true,
  });
}
