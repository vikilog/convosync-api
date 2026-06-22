import type { PrismaClient } from '@prisma/client';
import { googleService, GoogleService } from './services/google.service.js';

export type GoogleContainer = {
  googleService: GoogleService;
};

let container: GoogleContainer | null = null;

export function createGoogleContainer(_db: PrismaClient): GoogleContainer {
  return { googleService };
}

export function initGoogleModule(db: PrismaClient): GoogleContainer {
  if (!container) {
    container = createGoogleContainer(db);
  }
  return container;
}

/** For Journey Engine / AI Agent Google actions. */
export function getGoogleService(): GoogleService {
  if (!container) {
    return googleService;
  }
  return container.googleService;
}
