import type { PrismaClient } from '@prisma/client';
import { AiKnowledgeRepository } from './repositories/ai-knowledge.repository.js';
import { AIKnowledgeService } from './services/ai-knowledge.service.js';
import { MongoSyncService } from './services/mongo-sync.service.js';
import { NormalizerService } from './services/normalizer.service.js';
import { AiContextService } from './services/ai-context.service.js';
import { DynamicCollectionDiscoveryService } from './services/dynamic-collection-discovery.service.js';
import { RecursiveResolverService } from './services/recursive-resolver.service.js';

export type AiKnowledgeContainer = {
  aiKnowledgeService: AIKnowledgeService;
  aiContextService: AiContextService;
};

let container: AiKnowledgeContainer | null = null;

export function createAiKnowledgeContainer(db: PrismaClient): AiKnowledgeContainer {
  const repo = new AiKnowledgeRepository(db);
  const resolver = new RecursiveResolverService();
  const discovery = new DynamicCollectionDiscoveryService();
  const mongoSync = new MongoSyncService(resolver, discovery);
  const normalizer = new NormalizerService();
  const aiKnowledgeService = new AIKnowledgeService(repo, mongoSync, normalizer);
  const aiContextService = new AiContextService(repo);

  return { aiKnowledgeService, aiContextService };
}

export function initAiKnowledgeModule(db: PrismaClient): AiKnowledgeContainer {
  if (!container) {
    container = createAiKnowledgeContainer(db);
  }
  return container;
}
