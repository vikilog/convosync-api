import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../../middleware/auth.js';
import { prisma } from '../../../lib/prisma.js';
import { getRedis } from '../../../lib/redis.js';
import type { EmailContainer } from '../container.js';
import {
  createDomainSchema,
  createProviderSchema,
  createSenderSchema,
  setDefaultSenderSchema,
  listLogsSchema,
  sendEmailSchema,
  sesCredentialsDraftSchema,
  updateProviderSchema,
  upsertEmailTemplateSchema,
  updateEmailTemplateSchema,
  aiGenerateEmailTemplateSchema,
  verifyDomainSchema,
} from '../dto/email.dto.js';

export class EmailController {
  constructor(private readonly container: EmailContainer) {}

  getIntegration = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.container.integrationService.getStatus(workspaceId);
  };

  enableIntegration = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    try {
      const status = await this.container.integrationService.enable(workspaceId);
      return reply.code(200).send(status);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to enable email',
      });
    }
  };

  deleteIntegration = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    try {
      const status = await this.container.integrationService.disable(workspaceId);
      return reply.code(200).send(status);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to remove email integration',
      });
    }
  };

  listDomains = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.container.domainService.listDomains(workspaceId);
  };

  createDomain = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = createDomainSchema.parse(request.body);
    try {
      const domain = await this.container.domainService.addDomain(workspaceId, body);
      return reply.code(201).send(domain);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to add domain',
      });
    }
  };

  verifyDomain = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = verifyDomainSchema.parse(request.body);
    try {
      const domain = await this.container.domainService.verifyDomain(workspaceId, body.domainId);
      return domain;
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Verification failed',
      });
    }
  };

  refreshDomain = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      return await this.container.domainService.refreshDomainStatus(workspaceId, id);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Refresh failed',
      });
    }
  };

  listSenders = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.container.senderService.listSenders(workspaceId);
  };

  createSender = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const parsed = createSenderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid sender request',
      });
    }
    try {
      const sender = await this.container.senderService.createSender(workspaceId, parsed.data);
      return reply.code(201).send(sender);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to create sender',
      });
    }
  };

  setDefaultSender = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const parsed = setDefaultSenderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid default sender request',
      });
    }
    try {
      return await this.container.senderService.setDefaultSender(
        workspaceId,
        parsed.data.email
      );
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to set default sender',
      });
    }
  };

  sendEmail = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const parsed = sendEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid send request',
      });
    }
    const body = parsed.data;
    if (!body.templateId && !body.html && !body.text && !body.template) {
      return reply.code(400).send({ error: 'Provide html, text, template, or templateId' });
    }
    try {
      const log = await this.container.emailService.sendEmail(workspaceId, body);
      return reply.code(201).send(log);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Send failed',
      });
    }
  };

  listLogs = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    const query = listLogsSchema.parse(request.query ?? {});
    return this.container.emailService.listLogs(workspaceId, query.limit);
  };

  listProviders = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.container.providerConfigService.listProviders(workspaceId);
  };

  createProvider = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const parsed = createProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid provider request',
      });
    }
    try {
      const provider = await this.container.providerConfigService.createProvider(
        workspaceId,
        parsed.data
      );
      return reply.code(201).send(provider);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to create provider',
      });
    }
  };

  updateProvider = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const parsed = updateProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid provider update',
      });
    }
    try {
      return await this.container.providerConfigService.updateProvider(
        workspaceId,
        id,
        parsed.data
      );
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to update provider',
      });
    }
  };

  deleteProvider = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      await this.container.providerConfigService.deleteProvider(workspaceId, id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to delete provider',
      });
    }
  };

  setDefaultProvider = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      return await this.container.providerConfigService.setDefaultProvider(workspaceId, id);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to set default provider',
      });
    }
  };

  testProvider = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      return await this.container.providerConfigService.testProviderConnection(workspaceId, id);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Connection test failed',
      });
    }
  };

  refreshSesIdentitiesPreview = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const parsed = sesCredentialsDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid SES credentials',
      });
    }
    try {
      return await this.container.providerConfigService.refreshSesIdentities(workspaceId, {
        draft: parsed.data,
      });
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to refresh SES identities',
      });
    }
  };

  refreshSesIdentities = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const parsed = sesCredentialsDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid SES credentials',
      });
    }
    try {
      return await this.container.providerConfigService.refreshSesIdentities(workspaceId, {
        providerId: id,
        draft: parsed.data,
      });
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to refresh SES identities',
      });
    }
  };

  private async adminTestRecipient(request: FastifyRequest, reply: FastifyReply) {
    const { userId } = getJwtUser(request);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const to = user?.email?.trim();
    if (!to) {
      void reply.code(400).send({
        error: 'Your account has no email address to receive the test.',
      });
      return null;
    }
    return to;
  }

  testSesSendPreview = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const parsed = sesCredentialsDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid SES credentials',
      });
    }
    const to = await this.adminTestRecipient(request, reply);
    if (!to) return;
    try {
      const result = await this.container.providerConfigService.testSesSend(workspaceId, {
        to,
        draft: parsed.data,
      });
      if (!result.ok) return reply.code(400).send(result);
      return result;
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'SES test send failed',
      });
    }
  };

  testSesSend = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const parsed = sesCredentialsDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid SES credentials',
      });
    }
    const to = await this.adminTestRecipient(request, reply);
    if (!to) return;
    try {
      const result = await this.container.providerConfigService.testSesSend(workspaceId, {
        to,
        providerId: id,
        draft: parsed.data,
      });
      if (!result.ok) return reply.code(400).send(result);
      return result;
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'SES test send failed',
      });
    }
  };

  listEmailTemplates = async (request: FastifyRequest) => {
    const { workspaceId } = getJwtUser(request);
    return this.container.templateService.listTemplates(workspaceId);
  };

  getEmailTemplate = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const row = await this.container.templateService.getTemplate(workspaceId, id);
    if (!row) return reply.code(404).send({ error: 'Template not found' });
    return row;
  };

  createEmailTemplate = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const parsed = upsertEmailTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid template request',
      });
    }
    try {
      const row = await this.container.templateService.createTemplate(workspaceId, parsed.data);
      return reply.code(201).send(row);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to create template',
      });
    }
  };

  updateEmailTemplate = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const parsed = updateEmailTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid template update',
      });
    }
    try {
      return await this.container.templateService.updateTemplate(workspaceId, id, parsed.data);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to update template',
      });
    }
  };

  deleteEmailTemplate = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    try {
      await this.container.templateService.deleteTemplate(workspaceId, id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to delete template',
      });
    }
  };

  aiGenerateEmailTemplate = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = aiGenerateEmailTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid AI request',
      });
    }
    const { workspaceId } = getJwtUser(request);
    // Reachable directly via the API regardless of whether the "Generate
    // with AI" UI is currently wired up — cap it per workspace so a script
    // (or a re-enabled UI with no client-side guard) can't fire unbounded
    // concurrent LLM calls.
    const redis = getRedis();
    const rateKey = `email_ai_generate:${workspaceId}`;
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, 600);
    }
    if (count > 10) {
      return reply.code(429).send({
        error: 'Too many AI generation requests — try again in a few minutes.',
      });
    }
    try {
      return await this.container.templateService.generateWithAi(parsed.data.prompt);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'AI generation failed',
      });
    }
  };
}
