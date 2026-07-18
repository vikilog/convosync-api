import { prisma } from '../../lib/prisma.js';
import { getIo } from '../../socket.js';
import { config } from '../../config.js';

/** Merge insight-driven tags onto Contact.tags (same pattern as rule-based flows). */
export async function applyInsightTags(input: {
  workspaceId: string;
  contactId: string;
  churnRiskScore: number;
  purchaseIntentScore: number;
}): Promise<string[]> {
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, workspaceId: input.workspaceId },
    select: { id: true, tags: true },
  });
  if (!contact) return [];

  const add: string[] = [];
  if (input.churnRiskScore >= config.contactInsight.churnRiskTagThreshold) {
    add.push(config.contactInsight.churnRiskTag);
  }
  if (input.purchaseIntentScore >= config.contactInsight.purchaseIntentTagThreshold) {
    add.push(config.contactInsight.purchaseIntentTag);
  }
  if (add.length === 0) return [];

  const merged = Array.from(new Set([...contact.tags, ...add]));
  if (merged.length === contact.tags.length) return [];

  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { tags: merged },
  });

  try {
    getIo().to(input.workspaceId).emit('contact_updated', {
      contactId: contact.id,
      tags: updated.tags,
    });
  } catch (err) {
    console.warn('[contact-insight] tag socket emit failed', err);
  }

  return add;
}
