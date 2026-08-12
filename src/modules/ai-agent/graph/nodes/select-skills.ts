/**
 * NEW: skills on EVERY path (not only full_llm).
 * Reuses matchRelevantSkills from context-builder.service.ts.
 * Runs before retrieve_kb so linked knowledgeItemIds can scope retrieval.
 */
import { matchRelevantSkills } from '../../context-builder.service.js';
import type { AgentGraphStateType } from '../state.js';

export async function selectSkillsNode(
  state: AgentGraphStateType
): Promise<Partial<AgentGraphStateType>> {
  const skills = await state.fastify.prisma.aiSkill.findMany({
    where: { agentId: state.agentId, status: 'live' },
    select: { title: true, trigger: true, instructions: true, knowledgeItemIds: true },
  });

  const matched = matchRelevantSkills({
    skills,
    intent: state.intent || 'unknown',
    message: state.message,
  });

  return {
    matchedSkills: matched,
    skillsLoaded: matched.map((s) => s.title),
  };
}
