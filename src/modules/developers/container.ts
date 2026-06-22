import type { PrismaClient } from '@prisma/client';
import { initAiKnowledgeModule } from '../ai-knowledge/container.js';
import { DevelopersRepository } from './repositories/developers.repository.js';
import { WebhooksService } from './services/webhooks.service.js';
import { ActionsService } from './services/actions.service.js';
import { AiSyncDashboardService } from './services/ai-sync-dashboard.service.js';
import { registerDeveloperEventListeners } from './services/developer-events.service.js';

export type DevelopersContainer = {
  webhooksService: WebhooksService;
  actionsService: ActionsService;
  aiSyncDashboardService: AiSyncDashboardService;
  repo: DevelopersRepository;
};

let container: DevelopersContainer | null = null;

export function initDevelopersModule(db: PrismaClient): DevelopersContainer {
  if (container) return container;

  const repo = new DevelopersRepository(db);
  const webhooksService = new WebhooksService(repo);
  const actionsService = new ActionsService(repo);
  const { aiKnowledgeService } = initAiKnowledgeModule(db);
  const aiSyncDashboardService = new AiSyncDashboardService(repo, aiKnowledgeService);

  registerDeveloperEventListeners(webhooksService);

  container = {
    webhooksService,
    actionsService,
    aiSyncDashboardService,
    repo,
  };
  return container;
}
