import type { PrismaClient } from '@prisma/client';
import { InstagramJourneyRepository } from './repositories/ig-journey.repository.js';
import { InstagramJourneyExecutionRepository } from './repositories/ig-journey-execution.repository.js';
import { InstagramMessagingProvider } from './providers/instagram.messaging.provider.js';
import { InstagramJourneyGraphService } from './services/ig-journey-graph.service.js';
import { InstagramJourneyService } from './services/ig-journey.service.js';
import { InstagramJourneyEngine } from './services/ig-journey-engine.service.js';
import { InstagramJourneyTriggerService } from './services/ig-journey-trigger.service.js';
import { InstagramJourneyProgressService } from './services/ig-journey-progress.service.js';

export type InstagramJourneyContainer = {
  journeyService: InstagramJourneyService;
  graphService: InstagramJourneyGraphService;
  engine: InstagramJourneyEngine;
  triggerService: InstagramJourneyTriggerService;
  progressService: InstagramJourneyProgressService;
};

let container: InstagramJourneyContainer | null = null;

export function createInstagramJourneyContainer(db: PrismaClient): InstagramJourneyContainer {
  const journeyRepo = new InstagramJourneyRepository(db);
  const executionRepo = new InstagramJourneyExecutionRepository(db);
  const messaging = new InstagramMessagingProvider();
  const graphService = new InstagramJourneyGraphService(journeyRepo);
  const journeyService = new InstagramJourneyService(journeyRepo, graphService);
  const progressService = new InstagramJourneyProgressService(journeyRepo, executionRepo);

  // Late-bound so TRIGGER_JOURNEY can start another published IG automation
  let triggerService!: InstagramJourneyTriggerService;
  const engine = new InstagramJourneyEngine(
    journeyRepo,
    executionRepo,
    messaging,
    async (workspaceId, journeyId, contactId) => {
      await triggerService.startPublishedJourney(workspaceId, journeyId, contactId);
    }
  );
  triggerService = new InstagramJourneyTriggerService(journeyRepo, executionRepo, engine);

  return { journeyService, graphService, engine, triggerService, progressService };
}

export function initInstagramJourneyModule(db: PrismaClient): InstagramJourneyContainer {
  if (!container) container = createInstagramJourneyContainer(db);
  return container;
}

export function getInstagramJourneyContainer(db: PrismaClient): InstagramJourneyContainer {
  return initInstagramJourneyModule(db);
}
