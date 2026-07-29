/**
 * Smoke-test add_contact_tags only (does not escalate/close).
 *   npx tsx scripts/test-action-executor.ts <conversationId> <contactId>
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { executeActions } from '../src/modules/ai-agent/actions/action-executor.js';

async function main() {
  const conversationId = process.argv[2];
  const contactId = process.argv[3];
  if (!conversationId || !contactId) {
    console.error('Usage: npx tsx scripts/test-action-executor.ts <conversationId> <contactId>');
    process.exit(1);
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, workspaceId: true, contactId: true, assigneeId: true },
  });
  if (!conversation) {
    console.error('Conversation not found:', conversationId);
    process.exit(1);
  }
  if (conversation.contactId !== contactId) {
    console.error('contactId does not match conversation.contactId', {
      expected: conversation.contactId,
      got: contactId,
    });
    process.exit(1);
  }

  const before = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { tags: true },
  });

  const results = await executeActions(
    [{ type: 'add_contact_tags', config: { tags: ['test-tag'] } }],
    {
      prisma,
      workspaceId: conversation.workspaceId,
      conversationId,
      contactId,
      agentId: conversation.assigneeId ?? 'test-agent',
      agentName: 'Action Executor Test',
      intent: 'general',
      triggerReason: 'scripts/test-action-executor.ts',
    }
  );

  const after = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { tags: true },
  });

  console.log(JSON.stringify({ results, tagsBefore: before?.tags, tagsAfter: after?.tags }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
