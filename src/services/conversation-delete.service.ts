import { prisma } from '../index.js';

export async function deleteConversationThread(
  workspaceId: string,
  conversationId: string
): Promise<boolean> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true },
  });
  if (!conv) return false;

  await prisma.agentFlowSession.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });
  return true;
}
