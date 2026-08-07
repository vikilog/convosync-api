import type { EmailRepository } from '../repositories/email.repository.js';
import type { EmailProviderConfigService } from './provider-config.service.js';
import type { EmailSenderService } from './email.service.js';
import { assertChannelCreateAllowed } from '../../../services/planUsageGuards.js';
import { domainFromEmail } from '../utils/active-sending-identity.js';

export class EmailIntegrationService {
  constructor(
    private readonly repo: EmailRepository,
    private readonly providerConfigService: EmailProviderConfigService,
    private readonly senderService: EmailSenderService
  ) {}

  async assertEnabled(workspaceId: string): Promise<void> {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
  }

  async getStatus(workspaceId: string) {
    const enabled = await this.repo.isEmailIntegrationEnabled(workspaceId);
    const sendersPreview = await this.senderService.listSenders(workspaceId);
    const sharedDefault =
      sendersPreview.shared?.find((s) => s.isDefault) ??
      sendersPreview.shared?.[0] ??
      null;

    if (!enabled) {
      return {
        enabled: false,
        defaultSenderEmail: sendersPreview.defaultSenderEmail ?? sharedDefault?.email ?? null,
        defaultSenderName: sharedDefault?.displayName ?? sendersPreview.companyName ?? 'ConvoSync',
        verifiedDomainCount: 0,
        providerLabel: null as string | null,
        activeDomain: sendersPreview.activeDomain ?? domainFromEmail(sharedDefault?.email),
      };
    }

    const [domains, providers] = await Promise.all([
      this.repo.listDomains(workspaceId),
      this.providerConfigService.listProviders(workspaceId),
    ]);

    const allSenders = [...(sendersPreview.custom ?? []), ...(sendersPreview.shared ?? [])];
    const defaultSender =
      allSenders.find((s) => s.isDefault) ?? allSenders[0] ?? null;
    const verifiedDomains = domains.filter((d) => d.status === 'verified');
    const activeProvider =
      providers.find((p) => p.isDefault && p.status === 'active') ??
      providers.find((p) => p.status === 'active') ??
      null;

    const defaultSenderEmail =
      sendersPreview.defaultSenderEmail ??
      defaultSender?.email ??
      sharedDefault?.email ??
      null;

    return {
      enabled: true,
      defaultSenderEmail,
      defaultSenderName:
        defaultSender?.displayName ?? sharedDefault?.displayName ?? null,
      verifiedDomainCount: verifiedDomains.length,
      providerLabel: activeProvider?.provider ?? null,
      activeDomain:
        sendersPreview.activeDomain ?? domainFromEmail(defaultSenderEmail),
    };
  }

  async enable(workspaceId: string) {
    const already = await this.repo.isEmailIntegrationEnabled(workspaceId);
    if (already) {
      return this.getStatus(workspaceId);
    }

    await assertChannelCreateAllowed(workspaceId, 1, 'email');
    await this.repo.setEmailIntegrationEnabled(workspaceId, true);
    const hasSetup = await this.repo.hasExistingEmailSetup(workspaceId);
    if (!hasSetup) {
      await this.providerConfigService.ensureWorkspaceProviders(workspaceId);
    }
    return this.getStatus(workspaceId);
  }

  async disable(workspaceId: string) {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      return this.getStatus(workspaceId);
    }

    await this.repo.purgeWorkspaceEmailSetup(workspaceId);
    return this.getStatus(workspaceId);
  }
}
