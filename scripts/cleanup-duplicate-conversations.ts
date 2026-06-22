/**
 * Merges duplicate conversations (same contact + channel) into one canonical thread,
 * then deletes the extras. Run: npx tsx scripts/cleanup-duplicate-conversations.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function pickPreferredConversation(
  a: { status: string; lastMessageAt: Date | null; updatedAt: Date; createdAt: Date },
  b: { status: string; lastMessageAt: Date | null; updatedAt: Date; createdAt: Date }
) {
  const rank = (status: string) => (status === 'resolved' ? 0 : 1);
  const rankA = rank(a.status);
  const rankB = rank(b.status);
  if (rankA !== rankB) return rankA > rankB ? a : b;

  const time = (conv: { lastMessageAt: Date | null; updatedAt: Date; createdAt: Date }) =>
    (conv.lastMessageAt ?? conv.updatedAt ?? conv.createdAt).getTime();

  return time(a) >= time(b) ? a : b;
}

async function main() {
  const convs = await prisma.conversation.findMany({
    orderBy: { createdAt: 'asc' },
  });

  const groups = new Map<string, typeof convs>();
  for (const conv of convs) {
    const key = `${conv.workspaceId}|${conv.contactId}|${conv.channel}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(conv);
    groups.set(key, bucket);
  }

  let mergedMessages = 0;
  let deletedConversations = 0;
  let deletedSessions = 0;

  for (const [, list] of groups) {
    if (list.length <= 1) continue;

    let canonical = list[0];
    for (let i = 1; i < list.length; i++) {
      canonical = pickPreferredConversation(canonical, list[i]);
    }

    const duplicates = list.filter((c) => c.id !== canonical.id);

    for (const dup of duplicates) {
      const messages = await prisma.message.findMany({
        where: { conversationId: dup.id },
        orderBy: { createdAt: 'asc' },
      });

      for (const msg of messages) {
        if (msg.waMessageId) {
          const exists = await prisma.message.findFirst({
            where: { waMessageId: msg.waMessageId },
          });
          if (exists) {
            await prisma.message.delete({ where: { id: msg.id } });
            continue;
          }
        }

        await prisma.message.update({
          where: { id: msg.id },
          data: { conversationId: canonical.id },
        });
        mergedMessages += 1;
      }

      const sessions = await prisma.agentFlowSession.deleteMany({
        where: { conversationId: dup.id },
      });
      deletedSessions += sessions.count;

      await prisma.conversation.delete({ where: { id: dup.id } });
      deletedConversations += 1;
      console.log(`Deleted duplicate ${dup.id} (${dup.status}) → kept ${canonical.id}`);
    }

    const latest = await prisma.message.findFirst({
      where: { conversationId: canonical.id },
      orderBy: { createdAt: 'desc' },
    });

    if (latest) {
      await prisma.conversation.update({
        where: { id: canonical.id },
        data: {
          lastMessage: latest.content,
          lastMessageAt: latest.createdAt,
          status: canonical.status === 'resolved' ? 'open' : canonical.status,
        },
      });
    }
  }

  console.log('\nDone.');
  console.log('Merged messages moved:', mergedMessages);
  console.log('Deleted conversations:', deletedConversations);
  console.log('Deleted flow sessions:', deletedSessions);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
