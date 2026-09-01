import { prisma } from '../lib/prisma.js';

export async function isContactAutomationsPaused(contactId: string): Promise<boolean> {
  const row = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { automationsPaused: true },
  });
  return Boolean(row?.automationsPaused);
}

export async function setContactAutomationsPaused(
  workspaceId: string,
  contactId: string,
  paused: boolean
) {
  const result = await prisma.contact.updateMany({
    where: { id: contactId, workspaceId },
    data: { automationsPaused: paused },
  });
  return result.count > 0;
}
