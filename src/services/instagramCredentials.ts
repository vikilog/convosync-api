import { prisma } from '../lib/prisma.js';
import { decryptSecret } from '../lib/field-encryption.js';

export type WorkspaceInstagramCredentials = {
  pageId: string;
  pageAccessToken: string;
  instagramUserId: string;
  username?: string | null;
  displayName?: string | null;
};

export async function getWorkspaceInstagramCredentials(
  workspaceId: string,
  pageId?: string | null
): Promise<WorkspaceInstagramCredentials> {
  const account = pageId
    ? await prisma.instagramAccount.findFirst({ where: { workspaceId, pageId } })
    : await prisma.instagramAccount.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
      });

  const pageAccessToken = decryptSecret(account?.pageAccessToken);
  if (!account || !pageAccessToken) {
    throw new Error('Instagram not connected for this workspace');
  }

  return {
    pageId: account.pageId,
    pageAccessToken,
    instagramUserId: account.instagramUserId,
    username: account.username,
    displayName: account.displayName,
  };
}
