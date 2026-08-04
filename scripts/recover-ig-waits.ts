/**
 * Finish a stuck IG execution stuck on `running` (e.g. mid-node crash).
 * Run: npx tsx scripts/recover-ig-waits.ts [contactId]
 */
import { prisma } from '../src/lib/prisma.js';
import { createInstagramJourneyContainer } from '../src/modules/instagram-journey/container.js';

async function main() {
  const contactId = process.argv[2] || 'cms6cutu2000bp9mvpma27pjn';
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) {
    console.error('contact not found', contactId);
    process.exit(1);
  }

  const { triggerService, engine } = createInstagramJourneyContainer(prisma);

  const recovered = await triggerService.recoverWaitingFromRecentReplies(
    contact.workspaceId,
    contactId
  );
  console.log('waiting-recover', recovered);

  const stuck = await prisma.instagramJourneyExecution.findFirst({
    where: { contactId, status: 'running', currentNodeId: { not: null } },
    orderBy: { startedAt: 'desc' },
  });
  if (stuck?.currentNodeId) {
    console.log('re-executing', stuck.id, stuck.currentNodeId);
    await engine.executeNode(stuck.id, stuck.currentNodeId);
  }

  const e = await prisma.instagramJourneyExecution.findFirst({
    where: { contactId, status: { in: ['waiting', 'running', 'completed'] } },
    orderBy: { startedAt: 'desc' },
  });
  console.log('execution', e?.status, e?.currentNodeId);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
