import type { EmailDomain } from '@prisma/client';
import type { EmailRepository } from '../repositories/email.repository.js';
import { getSharedSenderDefinitions, isSharedSenderEmail } from '../constants/shared-domain.js';
import type { DomainStatusResult, EmailProviderName } from '../types/email.types.js';
import type { CreateDomainDto, CreateSenderDto, SendEmailDto } from '../dto/email.dto.js';
import type { EmailProviderConfigService } from './provider-config.service.js';
import type { EmailTemplateService } from './email-template.service.js';
import { assertEmailSendAllowed } from '../../../services/planUsageGuards.js';

function domainNeedsProviderSync(row: EmailDomain): boolean {
  if (!row.providerDomainId) return false;
  if (row.status !== 'verified') return true;
  return !row.spfVerified || !row.dkimVerified;
}

export class EmailDomainService {
  constructor(
    private readonly repo: EmailRepository,
    private readonly providerConfigService: EmailProviderConfigService
  ) {}

  private async pullProviderStatus(row: EmailDomain): Promise<DomainStatusResult> {
    const resolved = await this.providerConfigService.getResendBackedProvider(row.workspaceId);
    return resolved.provider.getDomainStatus(row.providerDomainId!);
  }

  private applyProviderStatus(row: EmailDomain, status: DomainStatusResult) {
    return this.repo.updateDomain(row.id, {
      status: status.status,
      spfVerified: status.spfVerified,
      dkimVerified: status.dkimVerified,
      dmarcVerified: status.dmarcVerified,
      dnsRecords: status.records,
      verifiedAt:
        status.status === 'verified' ? (row.verifiedAt ?? new Date()) : null,
    });
  }

  async listDomains(workspaceId: string) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      return [];
    }
    const domains = await this.repo.listDomains(workspaceId);
    const synced = await Promise.all(
      domains.map(async (domain) => {
        if (!domainNeedsProviderSync(domain)) return domain;
        try {
          const status = await this.pullProviderStatus(domain);
          return await this.applyProviderStatus(domain, status);
        } catch {
          return domain;
        }
      })
    );
    return synced.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  async addDomain(workspaceId: string, input: CreateDomainDto) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    const domain = input.domain.toLowerCase().trim();
    const existing = await this.repo.findDomainByName(workspaceId, domain);
    if (existing) throw new Error('Domain already added');

    const resolved = await this.providerConfigService.getResendBackedProvider(workspaceId);
    const created = await resolved.provider.createDomain(domain);

    return this.repo.createDomain({
      domain,
      provider: resolved.transportName,
      status: 'pending',
      providerDomainId: created.providerDomainId,
      spfVerified: false,
      dkimVerified: false,
      dmarcVerified: false,
      dnsRecords: created.records,
      workspace: { connect: { id: workspaceId } },
    });
  }

  async verifyDomain(workspaceId: string, domainId: string) {
    const row = await this.repo.findDomainById(workspaceId, domainId);
    if (!row) throw new Error('Domain not found');
    if (!row.providerDomainId) throw new Error('Domain is not linked to a provider');

    const resolved = await this.providerConfigService.getResendBackedProvider(workspaceId);
    const status = await resolved.provider.verifyDomain(row.providerDomainId);
    return this.applyProviderStatus(row, status);
  }

  async refreshDomainStatus(workspaceId: string, domainId: string) {
    const row = await this.repo.findDomainById(workspaceId, domainId);
    if (!row?.providerDomainId) throw new Error('Domain not found');

    const status = await this.pullProviderStatus(row);
    return this.applyProviderStatus(row, status);
  }
}

export class EmailSenderService {
  constructor(private readonly repo: EmailRepository) {}

  async listSenders(workspaceId: string) {
    const enabled = await this.repo.isEmailIntegrationEnabled(workspaceId);
    if (!enabled) {
      const sharedDefault = getSharedSenderDefinitions().find((s) => s.isDefault);
      return {
        enabled: false,
        shared: [],
        custom: [],
        defaultSenderEmail: sharedDefault?.email ?? null,
      };
    }

    const custom = await this.repo.listAddresses(workspaceId);
    const shared = getSharedSenderDefinitions().map((s) => ({
      id: `shared:${s.email}`,
      workspaceId,
      domainId: null,
      email: s.email,
      displayName: s.displayName,
      isDefault: s.isDefault,
      isShared: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      domain: null,
    }));
    return { enabled: true, shared, custom };
  }

  async createSender(workspaceId: string, input: CreateSenderDto) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    const email = input.email.toLowerCase().trim();

    if (input.useSharedDomain) {
      if (!isSharedSenderEmail(email)) {
        throw new Error(`Use a shared address on ${getSharedSenderDefinitions()[0]?.email.split('@')[1]}`);
      }
    } else {
      const domainPart = email.split('@')[1];
      if (!domainPart) throw new Error('Invalid email');

      let domainRow = input.domainId
        ? await this.repo.findDomainById(workspaceId, input.domainId)
        : await this.repo.findDomainByName(workspaceId, domainPart);

      if (!domainRow || domainRow.status !== 'verified') {
        throw new Error('Sender domain must be verified first');
      }
      if (domainRow.domain !== domainPart) {
        throw new Error('Email domain does not match verified domain');
      }

      const existing = await this.repo.findAddressByEmail(workspaceId, email);
      if (existing) throw new Error('Sender address already exists');

      if (input.isDefault) {
        await this.repo.clearDefaultSenders(workspaceId);
      }

      return this.repo.createAddress({
        email,
        displayName: input.displayName,
        isDefault: input.isDefault,
        isShared: false,
        workspace: { connect: { id: workspaceId } },
        domain: { connect: { id: domainRow.id } },
      });
    }

    const existing = await this.repo.findAddressByEmail(workspaceId, email);
    if (existing) throw new Error('Sender address already exists');

    if (input.isDefault) {
      await this.repo.clearDefaultSenders(workspaceId);
    }

    return this.repo.createAddress({
      email,
      displayName: input.displayName,
      isDefault: input.isDefault,
      isShared: true,
      workspace: { connect: { id: workspaceId } },
    });
  }
}

function applyTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => variables[key] ?? '');
}

export class EmailService {
  constructor(
    private readonly repo: EmailRepository,
    private readonly providerConfigService: EmailProviderConfigService,
    private readonly templateService: EmailTemplateService
  ) {}

  async validateSender(workspaceId: string, fromEmail: string): Promise<{
    email: string;
    displayName?: string | null;
    provider: EmailProviderName;
    isShared: boolean;
  }> {
    const normalized = fromEmail.toLowerCase().trim();
    const { transportName } = await this.providerConfigService.getDefaultForSending(workspaceId);

    if (isSharedSenderEmail(normalized)) {
      const shared = getSharedSenderDefinitions().find(
        (s) => s.email.toLowerCase() === normalized
      );
      return {
        email: normalized,
        displayName: shared?.displayName,
        provider: transportName,
        isShared: true,
      };
    }

    const address = await this.repo.findAddressByEmail(workspaceId, normalized);
    if (!address) {
      throw new Error('Sender address is not registered for this workspace');
    }
    if (address.isShared) {
      return {
        email: address.email,
        displayName: address.displayName,
        provider: transportName,
        isShared: true,
      };
    }
    if (!address.domain || address.domain.status !== 'verified') {
      throw new Error('Sender domain is not verified');
    }

    return {
      email: address.email,
      displayName: address.displayName,
      provider: transportName,
      isShared: false,
    };
  }

  async resolveDefaultSender(workspaceId: string): Promise<string> {
    const addresses = await this.repo.listAddresses(workspaceId);
    const customDefault = addresses.find((a) => a.isDefault);
    if (customDefault) return customDefault.email;

    const sharedDefault = getSharedSenderDefinitions().find((s) => s.isDefault);
    if (sharedDefault) return sharedDefault.email;

    throw new Error('No default sender configured');
  }

  async sendEmail(workspaceId: string, input: SendEmailDto) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    const recipientCount = Array.isArray(input.to) ? input.to.length : 1;
    await assertEmailSendAllowed(workspaceId, recipientCount);
    let subject = input.subject?.trim() ?? '';
    let html = input.template
      ? applyTemplate(input.template, input.variables ?? {})
      : input.html;
    let text = input.text;

    if (input.templateId) {
      const rendered = await this.templateService.renderTemplate(
        workspaceId,
        input.templateId,
        input.variables ?? {}
      );
      subject = rendered.subject;
      html = rendered.html;
      text = text ?? rendered.text;
    }

    if (!subject) {
      throw new Error('Email subject is required');
    }
    if (!html && !text && !input.template) {
      throw new Error('Provide html, text, or template');
    }

    const fromEmail = input.from ?? (await this.resolveDefaultSender(workspaceId));
    const sender = await this.validateSender(workspaceId, fromEmail);
    const resolved = await this.providerConfigService.getDefaultForSending(workspaceId);
    const provider = resolved.provider;

    const log = await this.repo.createLog({
      sender: sender.email,
      recipient: Array.isArray(input.to) ? input.to.join(', ') : input.to,
      subject,
      provider: resolved.transportName,
      providerName: resolved.configType,
      providerConfig: { connect: { id: resolved.configId } },
      status: 'queued',
      metadata: {
        ...(input.templateId ? { templateId: input.templateId } : {}),
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        ...(input.contactId ? { contactId: input.contactId } : {}),
      },
      workspace: { connect: { id: workspaceId } },
    });

    try {
      const result = await provider.sendEmail({
        from: sender.email,
        fromName: sender.displayName ?? undefined,
        to: input.to,
        subject,
        html,
        text,
        replyTo: input.replyTo,
      });

      return this.repo.updateLog(log.id, {
        status: 'sent',
        messageId: result.messageId,
      });
    } catch (err) {
      await this.repo.updateLog(log.id, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Send failed',
      });
      throw err;
    }
  }

  async sendTemplate(
    workspaceId: string,
    input: Omit<SendEmailDto, 'html' | 'text'> & { template: string; variables?: Record<string, string> }
  ) {
    return this.sendEmail(workspaceId, {
      ...input,
      template: input.template,
      variables: input.variables,
    });
  }

  async sendBulk(
    workspaceId: string,
    input: Omit<SendEmailDto, 'to'> & {
      recipients: Array<{ email: string; variables?: Record<string, string> }>;
      template: string;
    }
  ) {
    const results = [];
    for (const recipient of input.recipients) {
      const log = await this.sendEmail(workspaceId, {
        from: input.from,
        to: recipient.email,
        subject: input.subject,
        template: input.template,
        variables: recipient.variables ?? input.variables,
        replyTo: input.replyTo,
      });
      results.push(log);
    }
    return results;
  }

  listLogs(workspaceId: string, limit?: number) {
    return this.repo.listLogs(workspaceId, limit);
  }
}
