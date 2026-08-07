import type { FastifyInstance } from 'fastify';
import { prisma } from '../../../index.js';
import { companyAuth } from '../../../middleware/workspaceScope.js';
import { EmailController } from '../controllers/email.controller.js';
import { initEmailModule } from '../container.js';

export default async function emailRoutes(fastify: FastifyInstance) {
  const container = initEmailModule(prisma);
  const controller = new EmailController(container);
  const auth = companyAuth;

  fastify.get('/integration', auth, controller.getIntegration);
  fastify.post('/integration/enable', auth, controller.enableIntegration);
  fastify.delete('/integration', auth, controller.deleteIntegration);

  fastify.get('/domains', auth, controller.listDomains);
  fastify.post('/domains', auth, controller.createDomain);
  fastify.post('/domains/verify', auth, controller.verifyDomain);
  fastify.post('/domains/:id/refresh', auth, controller.refreshDomain);

  fastify.get('/senders', auth, controller.listSenders);
  fastify.post('/senders', auth, controller.createSender);
  fastify.post('/senders/default', auth, controller.setDefaultSender);

  fastify.post('/send', auth, controller.sendEmail);

  fastify.get('/logs', auth, controller.listLogs);

  fastify.get('/providers', auth, controller.listProviders);
  fastify.post('/providers', auth, controller.createProvider);
  // Static /ses/* before /:id so "ses" is not captured as an id.
  fastify.post('/providers/ses/refresh-identities', auth, controller.refreshSesIdentitiesPreview);
  fastify.post('/providers/ses/test-send', auth, controller.testSesSendPreview);
  fastify.patch('/providers/:id', auth, controller.updateProvider);
  fastify.delete('/providers/:id', auth, controller.deleteProvider);
  fastify.post('/providers/:id/default', auth, controller.setDefaultProvider);
  fastify.post('/providers/:id/test', auth, controller.testProvider);
  fastify.post('/providers/:id/refresh-identities', auth, controller.refreshSesIdentities);
  fastify.post('/providers/:id/test-send', auth, controller.testSesSend);

  fastify.get('/templates', auth, controller.listEmailTemplates);
  fastify.get('/templates/:id', auth, controller.getEmailTemplate);
  fastify.post('/templates', auth, controller.createEmailTemplate);
  fastify.patch('/templates/:id', auth, controller.updateEmailTemplate);
  fastify.delete('/templates/:id', auth, controller.deleteEmailTemplate);
  fastify.post('/templates/ai-generate', auth, controller.aiGenerateEmailTemplate);
}
