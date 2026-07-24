import { prisma } from '../lib/prisma.js';

const SEED_LIMIT = 40;

/**
 * Copy inbox Message rows into AgentChatMessage so hybrid LLM has prior context.
 * Idempotent when the agent chat already has messages.
 */
export async function seedAgentChatFromInbox(params: {
  workspaceId: string;
  agentId: string;
  inboxConversationId: string;
  /** Exclude this exact contact text (current inbound) to avoid duplicating it in history. */
  excludeContactText?: string | null;
}): Promise<{ agentChatId: string; seeded: number }> {
  const channel = `inbox:${params.inboxConversationId}`;

  let agentChat = await prisma.agentChatConversation.findFirst({
    where: {
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      channel,
      isActive: true,
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, messageCount: true },
  });

  if (!agentChat) {
    agentChat = await prisma.agentChatConversation.create({
      data: {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        channel,
        stage: 'intent_identified',
      },
      select: { id: true, messageCount: true },
    });
  }

  const existingCount = await prisma.agentChatMessage.count({
    where: { conversationId: agentChat.id },
  });

  // Keep inbox threads warm so ConversationService idle-timeout doesn't stub replies.
  await prisma.agentChatConversation.update({
    where: { id: agentChat.id },
    data: {
      lastMessageAt: new Date(),
      idleWarning1Sent: false,
      idleWarning2Sent: false,
      isActive: true,
      ...(existingCount === 0 && agentChat.messageCount > 0 ? { messageCount: 0 } : {}),
    },
  });

  if (existingCount > 0) {
    return { agentChatId: agentChat.id, seeded: 0 };
  }

  const inboxMessages = await prisma.message.findMany({
    where: { conversationId: params.inboxConversationId },
    orderBy: { createdAt: 'asc' },
    take: SEED_LIMIT + 5,
    select: { sender: true, content: true, type: true },
  });

  const exclude = params.excludeContactText?.trim() || null;
  const rows: Array<{ role: string; content: string }> = [];
  for (const m of inboxMessages) {
    const content = m.content?.trim();
    if (!content || content === '[media]') continue;
    if (m.type && m.type !== 'text' && m.type !== 'template') continue;
    const role = m.sender === 'contact' ? 'user' : 'assistant';
    rows.push({ role, content });
  }

  // Drop trailing duplicate of the inbound message about to be processed by chat().
  if (exclude && rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.role === 'user' && last.content === exclude) {
      rows.pop();
    }
  }

  const toInsert = rows.slice(-SEED_LIMIT);
  if (toInsert.length === 0) {
    return { agentChatId: agentChat.id, seeded: 0 };
  }

  await prisma.agentChatMessage.createMany({
    data: toInsert.map((r) => ({
      conversationId: agentChat!.id,
      role: r.role,
      content: r.content,
      tokensUsed: 0,
      intent: 'inbox_seed',
      fromCache: true,
    })),
  });

  await prisma.agentChatConversation.update({
    where: { id: agentChat.id },
    data: {
      messageCount: toInsert.length,
      stage: 'intent_identified',
      lastMessageAt: new Date(),
    },
  });

  return { agentChatId: agentChat.id, seeded: toInsert.length };
}
