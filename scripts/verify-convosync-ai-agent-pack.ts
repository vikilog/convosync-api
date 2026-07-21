/**
 * Counts + preview-style smoke (no HTTP server). Avoids importing backend index.
 *   npx tsx scripts/verify-convosync-ai-agent-pack.ts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { OpenAiProvider } from '../src/modules/ai-chat/providers/openai.provider.js';
import { retrieveKnowledgeChunks } from '../src/modules/ai-agent/knowledge/knowledge-retrieval.js';
import { AGENT_NAME } from '../src/content/convosync-agent-pack.js';

const openai = new OpenAiProvider();

async function previewReply(agentId: string, workspaceId: string, workspaceName: string, message: string) {
  const agent = await prisma.aiAgent.findFirst({
    where: { id: agentId, workspaceId },
    include: {
      skills: { orderBy: { createdAt: 'desc' } },
      knowledgeItems: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!agent) throw new Error('agent not found');

  const readyKnowledge = agent.knowledgeItems.filter((k) => k.status === 'ready');
  const { chunks } = await retrieveKnowledgeChunks({
    workspaceId,
    agentId,
    query: message,
    fallbackItems: readyKnowledge,
  });

  const liveSkills = agent.skills.filter((s) => s.status === 'live');
  const skills = liveSkills.length > 0 ? liveSkills : agent.skills;
  const skillBlock = skills
    .map((s) => `SKILL: ${s.title}\nTRIGGER: ${s.trigger}\nINSTRUCTIONS: ${s.instructions}`)
    .join('\n\n');
  const kbBlock = chunks.map((c) => `${c.title}: ${c.content ?? ''}`).join('\n\n');

  const system = `You are ${agent.name} for ${workspaceName}.
Tone: ${agent.toneOfVoice}
Instructions:
${agent.instructions ?? ''}
Brand:
${agent.brandBackground ?? ''}
Skills:
${skillBlock}
Knowledge:
${kbBlock}
Keep answers short. Do not invent prices.`;

  const { content } = await openai.createTextChatCompletion([
    { role: 'system', content: system },
    { role: 'user', content: message },
  ]);
  return content ?? '';
}

async function main() {
  const agent = await prisma.aiAgent.findFirst({
    where: { name: AGENT_NAME },
    include: {
      skills: true,
      knowledgeItems: true,
      workspace: { select: { id: true, name: true } },
    },
  });
  if (!agent) throw new Error(`${AGENT_NAME} not found`);

  const qna = agent.knowledgeItems.filter((k) => k.type === 'qna');
  const docs = agent.knowledgeItems.filter((k) => k.type === 'document');
  console.log({
    workspace: agent.workspace.name,
    agentId: agent.id,
    isPublished: agent.isPublished,
    isEnabled: agent.isEnabled,
    skills: agent.skills.length,
    qna: qna.length,
    docs: docs.length,
    ready: agent.knowledgeItems.filter((k) => k.status === 'ready').length,
  });

  if (agent.skills.length !== 8) throw new Error('expected 8 skills');
  if (qna.length < 20) throw new Error('expected >=20 qna');
  if (docs.length !== 3) throw new Error('expected 3 docs');

  const probes = [
    'What is ConvoSync?',
    'How do I connect WhatsApp?',
    'I want a demo',
  ];

  for (const message of probes) {
    const reply = await previewReply(
      agent.id,
      agent.workspaceId,
      agent.workspace.name,
      message
    );
    console.log(`\nQ: ${message}\nA: ${reply.slice(0, 500)}${reply.length > 500 ? '…' : ''}`);
    if (!reply.trim()) throw new Error(`empty reply for: ${message}`);
  }

  console.log('\nVerify OK');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
