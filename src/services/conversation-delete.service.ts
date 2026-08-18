import { prisma } from '../index.js';
import { deleteObject } from './objectStorage.js';

function storageKeyFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const key = (metadata as Record<string, unknown>).storageKey;
  return typeof key === 'string' && key ? key : null;
}

export async function deleteConversationThread(
  workspaceId: string,
  conversationId: string
): Promise<boolean> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true },
  });
  if (!conv) return false;

  const messages = await prisma.message.findMany({
    where: { conversationId },
    select: { metadata: true },
  });
  const storageKeys = messages
    .map((m) => storageKeyFromMetadata(m.metadata))
    .filter((k): k is string => k !== null);

  await prisma.agentFlowSession.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId } });

  // Best-effort, after the DB delete commits — a storage failure here
  // shouldn't undo or block an otherwise-successful conversation delete.
  await Promise.allSettled(storageKeys.map((key) => deleteObject(key)));

  return true;
}
