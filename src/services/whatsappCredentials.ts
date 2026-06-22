import { prisma } from '../index.js';
import { ensureWhatsAppAccountsMigrated } from './whatsappAccounts.js';

export type WorkspaceWhatsAppCredentials = {
  wabaId: string;
  accessToken: string;
  phoneNumberId?: string;
};

export async function getWorkspaceWhatsAppCredentials(
  workspaceId: string,
  phoneNumberId?: string | null
): Promise<WorkspaceWhatsAppCredentials> {
  await ensureWhatsAppAccountsMigrated(workspaceId);

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  const fallbackAccount = await prisma.whatsAppPhoneAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  const accessToken = workspace?.waToken;
  let wabaId = workspace?.wabaId || fallbackAccount?.wabaId;
  let resolvedPhoneNumberId =
    phoneNumberId || workspace?.waNumberId || fallbackAccount?.phoneNumberId;

  if (phoneNumberId) {
    const account = await prisma.whatsAppPhoneAccount.findFirst({
      where: { workspaceId, phoneNumberId },
    });
    if (!account) {
      throw new Error('WhatsApp number is not connected for this company.');
    }
    wabaId = account.wabaId || wabaId;
    resolvedPhoneNumberId = account.phoneNumberId;
  }

  if (!accessToken || !wabaId) {
    throw new Error(
      'WhatsApp is not connected for this company. Connect a number in WhatsApp Manager first.'
    );
  }

  return {
    wabaId,
    accessToken,
    phoneNumberId: resolvedPhoneNumberId,
  };
}
