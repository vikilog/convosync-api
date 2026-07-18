import { prisma } from '../index.js';
import { decryptSecret } from '../lib/field-encryption.js';

export type MessengerCredentials = {
  pageId: string;
  pageAccessToken: string;
  pageName?: string | null;
  displayName?: string | null;
};

export async function getWorkspaceMessengerCredentials(
  workspaceId: string,
  pageIdHint?: string | null
): Promise<MessengerCredentials> {
  const account = pageIdHint
    ? await prisma.messengerAccount.findFirst({
        where: { workspaceId, pageId: pageIdHint },
      })
    : await prisma.messengerAccount.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
      });

  const pageAccessToken = decryptSecret(account?.pageAccessToken);
  if (!account || !pageAccessToken) {
    throw new Error('Messenger not connected for this workspace');
  }

  return {
    pageId: account.pageId,
    pageAccessToken,
    pageName: account.pageName,
    displayName: account.displayName,
  };
}
