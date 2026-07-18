import { prisma } from '../index.js';
import { getIo } from '../socket.js';

/**
 * Mark outbound (agent) messages as read from Instagram `messaging_seen` / Messenger `message_reads`.
 * - Instagram: `read.mid` — that message + earlier agent msgs in the same thread
 * - Messenger: `read.watermark` — agent msgs with createdAt <= watermark
 */
export async function applyMessagingReadReceipt(params: {
  channel: 'instagram' | 'messenger';
  workspaceId: string;
  conversationId?: string;
  /** Instagram seen: specific message Graph mid */
  mid?: string;
  /** Messenger reads: ms timestamp watermark */
  watermarkMs?: number;
  log?: (label: string, payload: unknown) => void;
}): Promise<number> {
  const log = params.log ?? (() => undefined);
  const idsToMark = new Set<string>();
  let conversationId = params.conversationId;

  if (params.mid) {
    const anchor = await prisma.message.findFirst({
      where: { waMessageId: params.mid },
      include: { conversation: { select: { id: true, workspaceId: true, channel: true } } },
    });
    if (!anchor?.conversation) {
      log('read mid not found locally', { mid: params.mid });
      return 0;
    }
    if (anchor.conversation.workspaceId !== params.workspaceId) {
      log('read mid workspace mismatch', { mid: params.mid });
      return 0;
    }
    conversationId = anchor.conversation.id;
    idsToMark.add(anchor.id);

    const earlier = await prisma.message.findMany({
      where: {
        conversationId: anchor.conversation.id,
        sender: { not: 'contact' },
        status: { not: 'read' },
        createdAt: { lte: anchor.createdAt },
      },
      select: { id: true },
    });
    for (const m of earlier) idsToMark.add(m.id);
  } else if (params.watermarkMs != null && conversationId) {
    const cutoff = new Date(params.watermarkMs);
    const rows = await prisma.message.findMany({
      where: {
        conversationId,
        sender: { not: 'contact' },
        status: { not: 'read' },
        createdAt: { lte: cutoff },
      },
      select: { id: true },
    });
    for (const m of rows) idsToMark.add(m.id);
  } else {
    log('read event missing mid/watermark', {
      mid: params.mid,
      watermarkMs: params.watermarkMs,
      conversationId,
    });
    return 0;
  }

  if (idsToMark.size === 0) return 0;

  const idList = [...idsToMark];
  await prisma.message.updateMany({
    where: { id: { in: idList } },
    data: { status: 'read' },
  });

  for (const messageId of idList) {
    getIo().to(params.workspaceId).emit('message_status', {
      messageId,
      status: 'read',
    });
  }

  log('read applied', {
    channel: params.channel,
    conversationId,
    count: idList.length,
    mid: params.mid,
    watermarkMs: params.watermarkMs,
  });

  return idList.length;
}
