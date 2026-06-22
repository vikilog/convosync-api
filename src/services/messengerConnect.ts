import { prisma } from '../index.js';
import { assertChannelCreateAllowed } from './planUsageGuards.js';

export type MessengerConnectResult = {
  pageId: string;
  pageName?: string;
  displayName?: string;
  profilePicture?: string;
  tokenType: 'PAGE';
};

export class MessengerConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessengerConnectError';
  }
}

/**
 * Enable Messenger using the Page access token already stored from Instagram connect.
 * No separate Meta OAuth is required — same token powers IG DMs and Messenger inbox.
 */
export async function connectMessengerFromInstagramAccounts(
  workspaceId: string,
  pageId?: string
): Promise<MessengerConnectResult[]> {
  const instagramAccounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  if (instagramAccounts.length === 0) {
    throw new MessengerConnectError(
      'Connect Instagram first. Messenger uses the same Meta Page access token.'
    );
  }

  const targets = pageId
    ? instagramAccounts.filter((account) => account.pageId === pageId)
    : instagramAccounts;

  if (pageId && targets.length === 0) {
    throw new MessengerConnectError(
      `No connected Instagram account found for Page ${pageId}.`
    );
  }

  const existing = await prisma.messengerAccount.findMany({
    where: { workspaceId, pageId: { in: targets.map((item) => item.pageId) } },
    select: { pageId: true },
  });
  const existingPageIds = new Set(existing.map((item) => item.pageId));
  const newConnections = targets.filter((item) => !existingPageIds.has(item.pageId)).length;
  if (newConnections > 0) {
    await assertChannelCreateAllowed(workspaceId, newConnections);
  }

  const results: MessengerConnectResult[] = [];

  for (const ig of targets) {
    await prisma.messengerAccount.upsert({
      where: {
        workspaceId_pageId: {
          workspaceId,
          pageId: ig.pageId,
        },
      },
      create: {
        workspaceId,
        pageId: ig.pageId,
        metaUserId: ig.metaUserId,
        pageName: ig.pageName,
        displayName: ig.displayName || ig.pageName,
        profilePicture: ig.profilePicture,
        pageAccessToken: ig.pageAccessToken,
      },
      update: {
        metaUserId: ig.metaUserId,
        pageName: ig.pageName,
        displayName: ig.displayName || ig.pageName,
        profilePicture: ig.profilePicture,
        pageAccessToken: ig.pageAccessToken,
      },
    });

    results.push({
      pageId: ig.pageId,
      pageName: ig.pageName ?? undefined,
      displayName: ig.displayName || ig.pageName || undefined,
      profilePicture: ig.profilePicture ?? undefined,
      tokenType: 'PAGE',
    });
  }

  return results;
}

export async function listMessengerAccounts(workspaceId: string) {
  return prisma.messengerAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
}
