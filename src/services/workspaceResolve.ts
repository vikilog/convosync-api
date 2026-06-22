import { prisma } from '../index.js';
import type { Workspace } from '@prisma/client';

/** Pick the workspace that should receive inbound WhatsApp for this Meta phone_number_id. */
export async function resolveWorkspaceByPhoneNumberId(
  phoneNumberId: string
): Promise<Workspace | null> {
  const accounts = await prisma.whatsAppPhoneAccount.findMany({
    where: { phoneNumberId },
    include: { workspace: true },
    orderBy: { updatedAt: 'desc' },
  });

  if (accounts.length > 0) {
    const primary =
      accounts.find((a) => a.workspace.waNumberId === phoneNumberId) ?? accounts[0];
    return primary.workspace;
  }

  return prisma.workspace.findFirst({
    where: { waNumberId: phoneNumberId },
    orderBy: { updatedAt: 'desc' },
  });
}

/** Resolve company workspace from Meta Page ID (Instagram DMs). */
export async function resolveWorkspaceByPageId(pageId: string): Promise<Workspace | null> {
  const account = await findInstagramAccountByEntryId(pageId);
  return account?.workspace ?? null;
}

/** Meta webhooks may send entry.id as Page ID or Instagram business account ID. */
export async function findInstagramAccountByEntryId(entryId: string) {
  const id = entryId.trim();
  if (!id) return null;

  return prisma.instagramAccount.findFirst({
    where: {
      OR: [{ pageId: id }, { instagramUserId: id }],
    },
    include: { workspace: true },
  });
}

export async function findMessengerAccountByPageId(pageId: string) {
  const id = pageId.trim();
  if (!id) return null;

  return prisma.messengerAccount.findFirst({
    where: { pageId: id },
    include: { workspace: true },
  });
}
