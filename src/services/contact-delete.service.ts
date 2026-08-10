import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { deleteConversationThread } from './conversation-delete.service.js';

/** Trim; empty → null (reject at API boundary). */
export function normalizeContactTag(raw: string): string | null {
  const tag = raw.trim();
  return tag.length ? tag : null;
}

/** Hard-delete one contact + conversation threads (same as DELETE /contacts/:id). */
export async function deleteContactInWorkspace(
  workspaceId: string,
  contactId: string
): Promise<{ deleted: boolean; deletedConversations: number }> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: { id: true },
  });
  if (!contact) return { deleted: false, deletedConversations: 0 };

  const conversations = await prisma.conversation.findMany({
    where: { workspaceId, contactId },
    select: { id: true },
  });

  for (const conv of conversations) {
    await deleteConversationThread(workspaceId, conv.id);
    getIo().to(workspaceId).emit('conversation_deleted', { conversationId: conv.id });
  }
  await prisma.agentFlowSession.deleteMany({ where: { workspaceId, contactId } });
  await prisma.journeyExecution.deleteMany({ where: { contactId } });
  await prisma.contact.delete({ where: { id: contactId } });
  getIo().to(workspaceId).emit('contact_deleted', { contactId });

  return { deleted: true, deletedConversations: conversations.length };
}

export async function countContactsWithTag(
  workspaceId: string,
  tag: string
): Promise<number> {
  return prisma.contact.count({
    where: { workspaceId, tags: { has: tag } },
  });
}

export async function deleteContactsByTag(
  workspaceId: string,
  tag: string
): Promise<{ deleted: number }> {
  // ponytail: sequential per-contact cascade; ceiling ~few k contacts/tag — upgrade = batched deletes
  const contacts = await prisma.contact.findMany({
    where: { workspaceId, tags: { has: tag } },
    select: { id: true },
  });
  let deleted = 0;
  for (const c of contacts) {
    const result = await deleteContactInWorkspace(workspaceId, c.id);
    if (result.deleted) deleted += 1;
  }
  return { deleted };
}
