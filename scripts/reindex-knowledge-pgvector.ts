/**
 * One-shot: reindex all AiAgentKnowledgeItem rows into pgvector.
 * Usage: cd backend && npx tsx scripts/reindex-knowledge-pgvector.ts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { knowledgeIndexService } from '../src/modules/ai-agent/knowledge/knowledge-index.service.js';

async function main() {
  if (!knowledgeIndexService.isEnabled()) {
    throw new Error('Embeddings not enabled (set OPENAI_API_KEY)');
  }

  const agents = await prisma.aiAgent.findMany({
    select: { id: true, workspaceId: true, name: true },
  });

  let indexed = 0;
  for (const agent of agents) {
    const items = await prisma.aiAgentKnowledgeItem.findMany({ where: { agentId: agent.id } });
    console.log(`agent=${agent.name} items=${items.length}`);
    for (const item of items) {
      await knowledgeIndexService.indexItem(agent.workspaceId, item);
      indexed += 1;
    }
  }

  const chunks = await prisma.$queryRawUnsafe<{ c: number }[]>(
    'SELECT count(*)::int AS c FROM knowledge_chunks'
  );
  console.log(`done indexed=${indexed} chunks=${chunks[0]?.c ?? 0}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
