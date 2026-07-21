/**
 * Idempotent seed: ConvoSync Support AI agent + skills + knowledge + actions.
 *
 * Usage:
 *   cd backend && npx tsx scripts/seed-convosync-ai-agent-pack.ts
 *   WORKSPACE_ID=xxx npx tsx scripts/seed-convosync-ai-agent-pack.ts
 *
 * Leaves agent unpublished / disabled for UI review before going live on inbox.
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { indexKnowledgeItemInBackground } from '../src/modules/ai-agent/knowledge/knowledge-index.service.js';
import {
  ACTIONS,
  AGENT_DESCRIPTION,
  AGENT_NAME,
  AGENT_ROLE,
  assertConvosyncAgentPackShape,
  BRAND_BACKGROUND,
  DOCUMENTS,
  INSTRUCTIONS,
  QNA,
  SKILLS,
} from '../src/content/convosync-agent-pack.js';

async function resolveWorkspace(): Promise<{ id: string; name: string }> {
  const fromEnv = process.env.WORKSPACE_ID?.trim();
  if (fromEnv) {
    const ws = await prisma.workspace.findUnique({
      where: { id: fromEnv },
      select: { id: true, name: true },
    });
    if (!ws) throw new Error(`WORKSPACE_ID not found: ${fromEnv}`);
    return ws;
  }

  const bySlug = await prisma.workspace.findFirst({
    where: { slug: 'convosync' },
    select: { id: true, name: true },
  });
  if (bySlug) return bySlug;

  const byName = await prisma.workspace.findFirst({
    where: { name: { equals: 'ConvoSync', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (byName) return byName;

  throw new Error('ConvoSync workspace not found (slug=convosync). Set WORKSPACE_ID to override.');
}

function qnaContent(question: string, answer: string): string {
  const pairs = [{ question, answer }];
  return JSON.stringify(pairs);
}

async function main() {
  assertConvosyncAgentPackShape();

  const workspace = await resolveWorkspace();
  console.log(`Seeding AI agent pack → ${workspace.name} (${workspace.id})`);

  let agent = await prisma.aiAgent.findFirst({
    where: { workspaceId: workspace.id, name: AGENT_NAME },
  });

  const actionsJson = ACTIONS.map((a) => ({
    type: a.type,
    enabled: a.enabled,
    instruction: a.instruction,
  }));

  if (!agent) {
    agent = await prisma.aiAgent.create({
      data: {
        workspaceId: workspace.id,
        name: AGENT_NAME,
        role: AGENT_ROLE,
        category: 'ai_agent',
        description: AGENT_DESCRIPTION,
        systemPrompt: AGENT_DESCRIPTION,
        instructions: INSTRUCTIONS,
        brandBackground: BRAND_BACKGROUND,
        toneOfVoice: 'friendly',
        fallbackLanguage: 'english',
        actions: actionsJson,
        isPublished: false,
        publishedAt: null,
        isEnabled: false,
        welcomeMessageEnabled: true,
        welcomeMessageText:
          "Hi! I'm ConvoSync Support — ask me about the product, WhatsApp setup, templates, or booking a demo.",
      },
    });
    console.log(`  create agent ${agent.id}`);
  } else {
    agent = await prisma.aiAgent.update({
      where: { id: agent.id },
      data: {
        role: AGENT_ROLE,
        category: 'ai_agent',
        description: AGENT_DESCRIPTION,
        systemPrompt: AGENT_DESCRIPTION,
        instructions: INSTRUCTIONS,
        brandBackground: BRAND_BACKGROUND,
        toneOfVoice: 'friendly',
        fallbackLanguage: 'english',
        actions: actionsJson,
        // keep publish/enable flags as-is if already reviewed
      },
    });
    console.log(`  update agent ${agent.id} (published=${agent.isPublished} enabled=${agent.isEnabled})`);
  }

  let skillsUpserted = 0;
  for (const skill of SKILLS) {
    const existing = await prisma.aiSkill.findFirst({
      where: { agentId: agent.id, title: skill.title },
    });
    if (existing) {
      await prisma.aiSkill.update({
        where: { id: existing.id },
        data: {
          trigger: skill.trigger,
          instructions: skill.instructions,
          status: skill.status,
        },
      });
    } else {
      await prisma.aiSkill.create({
        data: {
          agentId: agent.id,
          title: skill.title,
          trigger: skill.trigger,
          instructions: skill.instructions,
          status: skill.status,
        },
      });
    }
    skillsUpserted += 1;
  }
  console.log(`  skills upserted=${skillsUpserted}`);

  let knowledgeUpserted = 0;
  const toIndex: { workspaceId: string; itemId: string }[] = [];

  for (const q of QNA) {
    const content = qnaContent(q.question, q.answer);
    const metadata = { pairs: [{ question: q.question, answer: q.answer }] };
    const existing = await prisma.aiAgentKnowledgeItem.findFirst({
      where: { agentId: agent.id, title: q.title, type: 'qna' },
    });
    const item = existing
      ? await prisma.aiAgentKnowledgeItem.update({
          where: { id: existing.id },
          data: { content, metadata, status: 'ready' },
        })
      : await prisma.aiAgentKnowledgeItem.create({
          data: {
            agentId: agent.id,
            type: 'qna',
            title: q.title,
            content,
            metadata,
            status: 'ready',
          },
        });
    toIndex.push({ workspaceId: workspace.id, itemId: item.id });
    knowledgeUpserted += 1;
  }

  for (const doc of DOCUMENTS) {
    const existing = await prisma.aiAgentKnowledgeItem.findFirst({
      where: { agentId: agent.id, title: doc.title, type: 'document' },
    });
    const item = existing
      ? await prisma.aiAgentKnowledgeItem.update({
          where: { id: existing.id },
          data: { content: doc.content, status: 'ready' },
        })
      : await prisma.aiAgentKnowledgeItem.create({
          data: {
            agentId: agent.id,
            type: 'document',
            title: doc.title,
            content: doc.content,
            status: 'ready',
          },
        });
    toIndex.push({ workspaceId: workspace.id, itemId: item.id });
    knowledgeUpserted += 1;
  }
  console.log(`  knowledge upserted=${knowledgeUpserted}`);

  // Best-effort vector index (no-op if Pinecone/embeddings unset)
  let indexed = 0;
  for (const ref of toIndex) {
    const item = await prisma.aiAgentKnowledgeItem.findUnique({ where: { id: ref.itemId } });
    if (!item) continue;
    await indexKnowledgeItemInBackground(ref.workspaceId, item);
    indexed += 1;
  }
  console.log(`  knowledge index attempted=${indexed}`);

  console.log(`Done. Agent "${AGENT_NAME}" id=${agent.id}`);
  console.log('Review in AI Agent → Profile / Skills / Knowledge, then publish when ready.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
