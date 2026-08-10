import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { mergeSendErrorMetadata } from '../lib/messageResendStatus.js';

/** Persist an outbound send that failed before Meta accepted it (enables Resend). */
export async function persistFailedOutboundMessage(opts: {
  workspaceId: string;
  conversationId: string;
  senderName: string;
  content: string;
  type?: string;
  metadata?: Record<string, unknown>;
  sendError: string;
}) {
  const message = await prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      sender: 'agent',
      senderName: opts.senderName,
      content: opts.content,
      type: opts.type ?? 'text',
      status: 'failed',
      metadata: mergeSendErrorMetadata(opts.metadata ?? {}, opts.sendError) as object,
    },
  });

  await prisma.conversation.updateMany({
    where: { id: opts.conversationId, workspaceId: opts.workspaceId },
    data: {
      lastMessage: opts.content,
      lastMessageAt: new Date(),
    },
  });

  getIo().to(opts.workspaceId).emit('new_message', {
    conversationId: opts.conversationId,
    message,
  });

  return message;
}
