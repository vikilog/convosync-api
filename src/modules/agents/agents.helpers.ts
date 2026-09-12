import type { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AGENT_CATEGORY } from '../../routes/agents.schemas.js';

/** Dedupe + ensure every id belongs to this agent. Throws Zod-style Error message. */
export async function resolveSkillKnowledgeIds(
  agentId: string,
  ids: string[] | undefined
): Promise<string[]> {
  const deduped = [...new Set((ids ?? []).filter(Boolean))];
  if (deduped.length === 0) return [];
  const found = await prisma.aiAgentKnowledgeItem.findMany({
    where: { agentId, id: { in: deduped } },
    select: { id: true },
  });
  if (found.length !== deduped.length) {
    const ok = new Set(found.map((r) => r.id));
    const bad = deduped.filter((id) => !ok.has(id));
    throw new Error(`Invalid knowledgeItemIds for this agent: ${bad.join(', ')}`);
  }
  return deduped;
}

export async function getAgentOr404(workspaceId: string, id: string) {
  return prisma.aiAgent.findFirst({ where: { id, workspaceId } });
}

export const DEFAULT_PROMPTS: Record<z.infer<typeof AGENT_CATEGORY>, string> = {
  ai_agent:
    'Configure agent behavior through system instructions for personalized and scenario-specific automation.',
  responsive:
    "Triggered by the client's inbound messages, ideal for solving questions in real time.",
  rule_based: 'No AI, just simple flow-based behavior, ideal for routine tasks.',
};
