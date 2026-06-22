import { prisma } from '../index.js';

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

  if (!account?.pageAccessToken) {
    throw new Error('Instagram not connected for this workspace');
  }

  return {
    pageId: account.pageId,
    pageAccessToken: account.pageAccessToken,
    instagramUserId: account.instagramUserId,
    username: account.username,
    displayName: account.displayName,
  };
}
