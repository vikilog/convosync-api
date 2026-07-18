import { prisma } from '../index.js';
import { decryptSecret } from '../lib/field-encryption.js';

export type WorkspaceFacebookPageCredentials = {
  pageId: string;
  pageAccessToken: string;
  pageName: string | null;
};

export async function getWorkspaceFacebookPageCredentials(
  workspaceId: string
): Promise<WorkspaceFacebookPageCredentials | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { fbPageId: true, fbPageToken: true, fbPageName: true },
  });

  const pageAccessToken = decryptSecret(workspace?.fbPageToken);
  if (!workspace?.fbPageId || !pageAccessToken) return null;

  return {
    pageId: workspace.fbPageId,
    pageAccessToken,
    pageName: workspace.fbPageName,
  };
}

export async function getWorkspaceMetaUserToken(workspaceId: string): Promise<string | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { metaUserToken: true },
  });
  return decryptSecret(workspace?.metaUserToken);
}
