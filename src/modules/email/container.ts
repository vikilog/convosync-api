import type { PrismaClient } from '@prisma/client';
import { EmailRepository } from './repositories/email.repository.js';
import {
  EmailDomainService,
  EmailSenderService,
  EmailService,
} from './services/email.service.js';
import { EmailProviderConfigService } from './services/provider-config.service.js';
import { EmailTemplateService } from './services/email-template.service.js';
import { EmailIntegrationService } from './services/email-integration.service.js';
import { EmailProviderFactory } from './providers/provider-factory.js';

export type EmailContainer = {
  repo: EmailRepository;
  factory: EmailProviderFactory;
  providerConfigService: EmailProviderConfigService;
  templateService: EmailTemplateService;
  integrationService: EmailIntegrationService;
  domainService: EmailDomainService;
  senderService: EmailSenderService;
  emailService: EmailService;
};

let container: EmailContainer | null = null;

export function createEmailContainer(db: PrismaClient): EmailContainer {
  const repo = new EmailRepository(db);
  const factory = new EmailProviderFactory();
  const providerConfigService = new EmailProviderConfigService(repo, factory);
  const templateService = new EmailTemplateService(repo);
  const senderService = new EmailSenderService(repo);
  const integrationService = new EmailIntegrationService(
    repo,
    providerConfigService,
    senderService
  );
  return {
    repo,
    factory,
    providerConfigService,
    templateService,
    integrationService,
    domainService: new EmailDomainService(repo, providerConfigService),
    senderService,
    emailService: new EmailService(repo, providerConfigService, templateService),
  };
}

export function initEmailModule(db: PrismaClient): EmailContainer {
  if (!container) {
    container = createEmailContainer(db);
  }
  return container;
}

/** For future Journey SEND_EMAIL / AI send_email integration. */
export function getEmailService(): EmailService {
  if (!container) {
    throw new Error('Email module not initialized');
  }
  return container.emailService;
}

/** For future modules that need workspace-scoped provider resolution. */
export function getEmailProviderConfigService(): EmailProviderConfigService {
  if (!container) {
    throw new Error('Email module not initialized');
  }
  return container.providerConfigService;
}
