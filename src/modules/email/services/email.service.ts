import type { EmailDomain } from '@prisma/client';
import type { EmailRepository } from '../repositories/email.repository.js';
import { getSharedSenderDefinitions, isSharedSenderEmail } from '../constants/shared-domain.js';
import type { DomainStatusResult, EmailProviderName } from '../types/email.types.js';
import type { CreateDomainDto, CreateSenderDto, SendEmailDto } from '../dto/email.dto.js';
import type { EmailProviderConfigService } from './provider-config.service.js';
import type { EmailTemplateService } from './email-template.service.js';
import {
  assertEmailSendAffordable,
  chargeEmailSendUsage,
} from '../../../services/walletUsage.js';
import { InsufficientWalletBalanceError } from '../../../services/wallet.service.js';
import { WorkspaceEmailConfigService } from './workspace-email-config.service.js';
import { prisma } from '../../../lib/prisma.js';
import {
  domainFromEmail,
  pickActiveSendingEmail,
} from '../utils/active-sending-identity.js';
import { usesPlatformEmailMetering } from '../types/provider-config.types.js';

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
    const resolved = await this.providerConfigService.getDomainManagementProvider(row.workspaceId);
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
    let hideVendor = false;
    try {
      const resolved =
        await this.providerConfigService.getDomainManagementProvider(workspaceId);
      hideVendor = resolved.configType === 'CONVOSYNC_MANAGED';
    } catch {
      /* no domain provider configured */
    }

    return synced
      .map((domain) =>
        hideVendor && (domain.provider === 'resend' || domain.provider === 'ses')
          ? { ...domain, provider: 'ConvoSync' }
          : domain
      )
      .sort(
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

    const resolved = await this.providerConfigService.getDomainManagementProvider(workspaceId);
    const created = await resolved.provider.createDomain(domain);

    return this.repo.createDomain({
      domain,
      provider: resolved.configType === 'CONVOSYNC_MANAGED' ? 'ConvoSync' : resolved.transportName,
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

    const resolved = await this.providerConfigService.getDomainManagementProvider(workspaceId);
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
  constructor(
    private readonly repo: EmailRepository,
    private readonly providerConfigService?: EmailProviderConfigService
  ) {}

  private async workspaceBrand(workspaceId: string) {
    const ws = await this.repo.getWorkspaceBrand(workspaceId);
    return {
      slug: ws?.slug ?? 'workspace',
      name: ws?.name?.trim() || 'ConvoSync',
    };
  }

  async listSenders(workspaceId: string) {
    const brand = await this.workspaceBrand(workspaceId);
    const defs = getSharedSenderDefinitions(brand);
    const enabled = await this.repo.isEmailIntegrationEnabled(workspaceId);
    const platformSharedEmail = defs.find((s) => s.isDefault)?.email ?? defs[0]?.email ?? null;

    if (!enabled) {
      return {
        enabled: false,
        shared: [],
        custom: [],
        companyName: brand.name,
        defaultSenderEmail: platformSharedEmail,
        activeDomain: domainFromEmail(platformSharedEmail),
      };
    }

    const providerSender =
      (await this.providerConfigService?.getDefaultProviderSender(workspaceId)) ?? null;
    const activeEmail = pickActiveSendingEmail({
      defaultProviderType: providerSender?.provider ?? null,
      defaultProviderStatus: providerSender?.status ?? null,
      defaultProviderSenderEmail: providerSender?.email ?? null,
      platformSharedEmail,
    });
    const providerIsActiveDefault =
      Boolean(providerSender?.email) &&
      activeEmail === providerSender!.email.toLowerCase();

    const custom = await this.repo.listAddresses(workspaceId);
    const defaultRow = custom.find((a) => a.isDefault);
    const customIsDefault =
      !providerIsActiveDefault &&
      Boolean(defaultRow) &&
      !isSharedSenderEmail(defaultRow!.email) &&
      !defaultRow!.isShared;

    // When SES (or other BYO) is the default provider, that From is the only
    // "Your domain" / default — do not keep advertising the platform shared address.
    if (providerIsActiveDefault && providerSender) {
      const email = providerSender.email.toLowerCase();
      const domain = domainFromEmail(email);
      const localPart = email.split('@')[0] ?? '';
      return {
        enabled: true,
        shared: [
          {
            id: `provider-default:${email}`,
            workspaceId,
            domainId: null as string | null,
            email,
            displayName: domain ?? brand.name,
            isDefault: true,
            isShared: false as const,
            localPart,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            domain: domain ? { domain, status: 'verified' as const } : null,
          },
        ],
        custom: custom.filter((a) => !isSharedSenderEmail(a.email)),
        companyName: brand.name,
        defaultSenderEmail: email,
        activeDomain: domain,
      };
    }

    const shared = defs.map((s) => {
      const branded = s.email.toLowerCase();
      const row =
        custom.find((a) => a.email.toLowerCase() === branded) ??
        custom.find((a) => isSharedSenderEmail(a.email));
      return {
        id: row?.id ?? `shared:${s.email}`,
        workspaceId,
        domainId: null as string | null,
        email: s.email,
        displayName: s.displayName,
        isDefault: !customIsDefault,
        isShared: true as const,
        localPart: s.localPart,
        createdAt: row?.createdAt ?? new Date(0),
        updatedAt: row?.updatedAt ?? new Date(0),
        domain: null,
      };
    });

    const customOnly = custom.filter((a) => !isSharedSenderEmail(a.email));
    const defaultSenderEmail =
      (customIsDefault ? defaultRow!.email : null) ??
      activeEmail ??
      platformSharedEmail;

    return {
      enabled: true,
      shared,
      custom: customOnly,
      companyName: brand.name,
      defaultSenderEmail,
      activeDomain: domainFromEmail(defaultSenderEmail),
    };
  }

  async setDefaultSender(workspaceId: string, email: string) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    const brand = await this.workspaceBrand(workspaceId);
    const normalized = email.toLowerCase().trim();
    const defs = getSharedSenderDefinitions(brand);
    const sharedDef = defs.find((d) => d.email.toLowerCase() === normalized);

    await this.repo.clearDefaultSenders(workspaceId);

    if (sharedDef) {
      const existing = await this.repo.findAddressByEmail(workspaceId, normalized);
      if (existing) {
        return this.repo.updateAddress(existing.id, {
          isDefault: true,
          isShared: true,
          displayName: sharedDef.displayName,
        });
      }
      return this.repo.createAddress({
        email: normalized,
        displayName: sharedDef.displayName,
        isDefault: true,
        isShared: true,
        workspace: { connect: { id: workspaceId } },
      });
    }

    const existing = await this.repo.findAddressByEmail(workspaceId, normalized);
    if (!existing) throw new Error('Sender address is not registered for this workspace');
    return this.repo.updateAddress(existing.id, { isDefault: true });
  }

  async createSender(workspaceId: string, input: CreateSenderDto) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    const brand = await this.workspaceBrand(workspaceId);
    const email = input.email.toLowerCase().trim();

    if (input.useSharedDomain) {
      if (!isSharedSenderEmail(email)) {
        const example = getSharedSenderDefinitions(brand)[0]?.email;
        throw new Error(`Use a shared address like ${example}`);
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

    const sharedDef = getSharedSenderDefinitions(brand).find(
      (d) => d.email.toLowerCase() === email
    );

    return this.repo.createAddress({
      email,
      displayName: input.displayName || sharedDef?.displayName,
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

    const byoSes = await new WorkspaceEmailConfigService(prisma).resolveActiveSes(workspaceId);
    if (byoSes && byoSes.senderEmail.toLowerCase() === normalized) {
      return {
        email: normalized,
        displayName: null,
        provider: 'ses',
        isShared: false,
      };
    }

    const brand = await this.repo.getWorkspaceBrand(workspaceId);
    const workspace = {
      slug: brand?.slug ?? 'workspace',
      name: brand?.name?.trim() || 'ConvoSync',
    };

    if (isSharedSenderEmail(normalized)) {
      const shared = getSharedSenderDefinitions(workspace).find(
        (s) => s.email.toLowerCase() === normalized
      );
      const row = await this.repo.findAddressByEmail(workspaceId, normalized);
      return {
        email: normalized,
        displayName: row?.displayName ?? shared?.displayName,
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
    // Providers-tab default is source of truth (SES From > platform shared).
    const providerSender =
      await this.providerConfigService.getDefaultProviderSender(workspaceId);
    if (providerSender?.email) return providerSender.email;

    const byoSes = await new WorkspaceEmailConfigService(prisma).resolveActiveSes(workspaceId);
    if (byoSes) return byoSes.senderEmail;

    const addresses = await this.repo.listAddresses(workspaceId);
    const customDefault = addresses.find((a) => a.isDefault);
    if (customDefault) return customDefault.email;

    const brand = await this.repo.getWorkspaceBrand(workspaceId);
    const sharedDefault = getSharedSenderDefinitions({
      slug: brand?.slug ?? 'workspace',
      name: brand?.name?.trim() || 'ConvoSync',
    }).find((s) => s.isDefault);
    if (sharedDefault) return sharedDefault.email;

    throw new Error('No default sender configured');
  }

  async sendEmail(workspaceId: string, input: SendEmailDto) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    const recipientCount = Array.isArray(input.to) ? input.to.length : 1;
    // Platform (CONVOSYNC_MANAGED) = wallet CC only. BYOP (own SES/etc.) skips metering entirely.
    const resolved = await this.providerConfigService.getDefaultForSending(workspaceId);
    const meterPlatform = usesPlatformEmailMetering(resolved.configType);
    if (meterPlatform) {
      try {
        await assertEmailSendAffordable(workspaceId, recipientCount);
      } catch (err) {
        if (err instanceof InsufficientWalletBalanceError) {
          const needCc = err.requiredPaise / 100;
          const haveCc = err.balancePaise / 100;
          throw new Error(
            `Insufficient ConvoCoins to send email. Need ${needCc} CC, available ${haveCc} CC.`
          );
        }
        throw err;
      }
    }
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
    const provider = resolved.provider;

    const log = await this.repo.createLog({
      sender: sender.email,
      recipient: Array.isArray(input.to) ? input.to.join(', ') : input.to,
      subject,
      provider: meterPlatform ? 'platform' : resolved.transportName,
      providerName: meterPlatform ? 'ConvoSync' : resolved.configType,
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

      const sentAt = new Date().toISOString();
      const prevMeta =
        log.metadata && typeof log.metadata === 'object' && !Array.isArray(log.metadata)
          ? (log.metadata as Record<string, unknown>)
          : {};
      const updated = await this.repo.updateLog(log.id, {
        status: 'sent',
        messageId: result.messageId,
        metadata: {
          ...prevMeta,
          events: [{ type: 'sent', at: sentAt }],
        },
      });

      if (meterPlatform) {
        try {
          await chargeEmailSendUsage({
            workspaceId,
            referenceId: log.id,
            sendCount: recipientCount,
          });
        } catch (err) {
          console.error('[wallet] Email debit failed', err);
        }
      }

      return updated;
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
    return this.repo.listLogs(workspaceId, limit).then((logs) =>
      logs.map((log) => {
        const linked = log.providerConfig?.provider;
        const name = log.providerName ?? '';
        const provider = log.provider ?? '';
        const fromManagedConfig =
          linked === 'CONVOSYNC_MANAGED' || linked === 'WABIZ_MANAGED';
        if (
          fromManagedConfig ||
          name === 'CONVOSYNC_MANAGED' ||
          name === 'WABIZ_MANAGED' ||
          name === 'ConvoSync' ||
          provider === 'platform'
        ) {
          const { providerConfig: _cfg, ...rest } = log;
          return { ...rest, provider: 'platform', providerName: 'ConvoSync' };
        }
        const { providerConfig: _cfg, ...rest } = log;
        return rest;
      })
    );
  }
}
