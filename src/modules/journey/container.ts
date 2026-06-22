import type { PrismaClient } from '@prisma/client';
import { JourneyRepository } from './repositories/journey.repository.js';
import { JourneyExecutionRepository } from './repositories/journey-execution.repository.js';
import { MetaCloudMessagingProvider } from './providers/meta-cloud.messaging.provider.js';
import { JourneyGraphService } from './services/journey-graph.service.js';
import { JourneyService } from './services/journey.service.js';
import { JourneyEngine } from './services/journey-engine.service.js';
import { JourneyTriggerService } from './services/journey-trigger.service.js';
import { JourneyAnalyticsService } from './services/journey-analytics.service.js';
import { JourneyProgressService } from './services/journey-progress.service.js';

export type JourneyContainer = {
  journeyService: JourneyService;
  graphService: JourneyGraphService;
  engine: JourneyEngine;
  triggerService: JourneyTriggerService;
  analyticsService: JourneyAnalyticsService;
  progressService: JourneyProgressService;
};

let container: JourneyContainer | null = null;

export function createJourneyContainer(db: PrismaClient): JourneyContainer {
  const journeyRepo = new JourneyRepository(db);
  const executionRepo = new JourneyExecutionRepository(db);
  const messagingProvider = new MetaCloudMessagingProvider();
  const graphService = new JourneyGraphService(journeyRepo);
  const journeyService = new JourneyService(journeyRepo, graphService);
  const engine = new JourneyEngine(journeyRepo, executionRepo, messagingProvider);
  const triggerService = new JourneyTriggerService(journeyRepo, executionRepo, engine);
  const analyticsService = new JourneyAnalyticsService(executionRepo);
  const progressService = new JourneyProgressService(journeyRepo, executionRepo);

  return {
    journeyService,
    graphService,
    engine,
    triggerService,
    analyticsService,
    progressService,
  };
}

export function getJourneyContainer(db: PrismaClient): JourneyContainer {
  if (!container) {
    container = createJourneyContainer(db);
  }
  return container;
}

export function initJourneyModule(db: PrismaClient): JourneyContainer {
  if (container) return container;
  container = createJourneyContainer(db);
  return container;
}
