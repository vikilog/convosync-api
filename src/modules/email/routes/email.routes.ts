import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { prisma } from '../../../index.js';
import { zodFirstIssueErrorHandler } from '../../../lib/errorHandler.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { EmailController } from '../controllers/email.controller.js';
import { initEmailModule } from '../container.js';
import {
  aiGenerateEmailTemplateSchema,
  createDomainSchema,
  createProviderSchema,
  createSenderSchema,
  listLogsSchema,
  sendEmailSchema,
  sesCredentialsDraftBodySchema,
  setDefaultSenderSchema,
  updateEmailTemplateSchema,
  updateProviderSchema,
  upsertEmailTemplateSchema,
  verifyDomainSchema,
} from '../email.schemas.js';

export default async function emailRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const container = initEmailModule(prisma);
  const controller = new EmailController(container);
  const auth = companyAuth;

  app.get('/integration', auth, controller.getIntegration);
  app.post('/integration/enable', auth, controller.enableIntegration);
  app.delete('/integration', auth, controller.deleteIntegration);

  app.get('/domains', auth, controller.listDomains);
  app.post('/domains', { ...auth, schema: { body: createDomainSchema } }, controller.createDomain);
  app.post(
    '/domains/verify',
    { ...auth, schema: { body: verifyDomainSchema } },
    controller.verifyDomain
  );
  app.post('/domains/:id/refresh', auth, controller.refreshDomain);

  app.get('/senders', auth, controller.listSenders);
  app.post(
    '/senders',
    {
      ...auth,
      schema: { body: createSenderSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid sender request'),
    },
    controller.createSender
  );
  app.post(
    '/senders/default',
    {
      ...auth,
      schema: { body: setDefaultSenderSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid default sender request'),
    },
    controller.setDefaultSender
  );

  app.post(
    '/send',
    {
      ...auth,
      schema: { body: sendEmailSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid send request'),
    },
    controller.sendEmail
  );

  app.get('/logs', { ...auth, schema: { querystring: listLogsSchema } }, controller.listLogs);

  app.get('/providers', auth, controller.listProviders);
  app.post(
    '/providers',
    {
      ...auth,
      schema: { body: createProviderSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid provider request'),
    },
    controller.createProvider
  );
  // Static /ses/* before /:id so "ses" is not captured as an id.
  app.post(
    '/providers/ses/refresh-identities',
    {
      ...auth,
      schema: { body: sesCredentialsDraftBodySchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid SES credentials'),
    },
    controller.refreshSesIdentitiesPreview
  );
  app.post(
    '/providers/ses/test-send',
    {
      ...auth,
      schema: { body: sesCredentialsDraftBodySchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid SES credentials'),
    },
    controller.testSesSendPreview
  );
  app.patch(
    '/providers/:id',
    {
      ...auth,
      schema: { body: updateProviderSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid provider update'),
    },
    controller.updateProvider
  );
  app.delete('/providers/:id', auth, controller.deleteProvider);
  app.post('/providers/:id/default', auth, controller.setDefaultProvider);
  app.post('/providers/:id/test', auth, controller.testProvider);
  app.post(
    '/providers/:id/refresh-identities',
    {
      ...auth,
      schema: { body: sesCredentialsDraftBodySchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid SES credentials'),
    },
    controller.refreshSesIdentities
  );
  app.post(
    '/providers/:id/test-send',
    {
      ...auth,
      schema: { body: sesCredentialsDraftBodySchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid SES credentials'),
    },
    controller.testSesSend
  );

  app.get('/templates', auth, controller.listEmailTemplates);
  app.get('/templates/:id', auth, controller.getEmailTemplate);
  app.post(
    '/templates',
    {
      ...auth,
      schema: { body: upsertEmailTemplateSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid template request'),
    },
    controller.createEmailTemplate
  );
  app.patch(
    '/templates/:id',
    {
      ...auth,
      schema: { body: updateEmailTemplateSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid template update'),
    },
    controller.updateEmailTemplate
  );
  app.delete('/templates/:id', auth, controller.deleteEmailTemplate);
  app.post(
    '/templates/ai-generate',
    {
      ...auth,
      schema: { body: aiGenerateEmailTemplateSchema },
      errorHandler: zodFirstIssueErrorHandler('Invalid AI request'),
    },
    controller.aiGenerateEmailTemplate
  );
}
