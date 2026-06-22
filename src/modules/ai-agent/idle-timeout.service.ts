import { FastifyInstance } from 'fastify';

export class IdleTimeoutService {
  constructor(private fastify: FastifyInstance) {}

  get prisma() {
    return this.fastify.prisma;
  }

  async checkAndHandleIdle(conversationId: string): Promise<{
    action: 'none' | 'warn1' | 'warn2' | 'close';
    message?: string;
  }> {
    const conversation = await this.prisma.agentChatConversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || !conversation.isActive) {
      return { action: 'none' };
    }

    const idleMinutes = Math.floor(
      (Date.now() - conversation.lastMessageAt.getTime()) / 60000
    );

    const timeout = parseInt(process.env.AI_IDLE_TIMEOUT_MINUTES || '15', 10);

    if (idleMinutes >= 5 && !conversation.idleWarning1Sent) {
      await this.prisma.agentChatConversation.update({
        where: { id: conversationId },
        data: { idleWarning1Sent: true },
      });
      return {
        action: 'warn1',
        message: 'Kya aap abhi bhi wahan hain? 😊 Main aapki help ke liye yahan hun!',
      };
    }

    if (idleMinutes >= 10 && !conversation.idleWarning2Sent) {
      await this.prisma.agentChatConversation.update({
        where: { id: conversationId },
        data: { idleWarning2Sent: true },
      });
      return {
        action: 'warn2',
        message:
          'Main yahan hun jab bhi zarurat ho! Feel free to reach out anytime. 👋',
      };
    }

    if (idleMinutes >= timeout) {
      await this.prisma.agentChatConversation.update({
        where: { id: conversationId },
        data: {
          isActive: false,
          closedAt: new Date(),
          closedReason: 'idle_timeout',
          stage: 'closed',
        },
      });
      return { action: 'close' };
    }

    return { action: 'none' };
  }

  async processAllIdleConversations(workspaceId?: string) {
    const where: {
      isActive: boolean;
      lastMessageAt: { lt: Date };
      workspaceId?: string;
    } = {
      isActive: true,
      lastMessageAt: {
        lt: new Date(Date.now() - 5 * 60 * 1000),
      },
    };
    if (workspaceId) where.workspaceId = workspaceId;

    const conversations = await this.prisma.agentChatConversation.findMany({ where });

    for (const conv of conversations) {
      await this.checkAndHandleIdle(conv.id);
    }
  }
}
