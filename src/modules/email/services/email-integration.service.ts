import type { EmailRepository } from '../repositories/email.repository.js';
import { getSharedSenderDefinitions } from '../constants/shared-domain.js';
import type { EmailProviderConfigService } from './provider-config.service.js';
import type { EmailSenderService } from './email.service.js';
import { assertChannelCreateAllowed } from '../../../services/planUsageGuards.js';

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
    const sharedDefault = getSharedSenderDefinitions().find((s) => s.isDefault);

    if (!enabled) {
      return {
        enabled: false,
        defaultSenderEmail: sharedDefault?.email ?? 'noreply@convosync.io',
        defaultSenderName: sharedDefault?.displayName ?? 'ConvoSync',
        verifiedDomainCount: 0,
        providerLabel: null as string | null,
      };
    }

    const [senders, domains, providers] = await Promise.all([
      this.senderService.listSenders(workspaceId),
      this.repo.listDomains(workspaceId),
      this.providerConfigService.listProviders(workspaceId),
    ]);

    const allSenders = [...(senders.custom ?? []), ...(senders.shared ?? [])];
    const defaultSender =
      allSenders.find((s) => s.isDefault) ?? allSenders[0] ?? null;
    const verifiedDomains = domains.filter((d) => d.status === 'verified');
    const activeProvider =
      providers.find((p) => p.isDefault && p.status === 'active') ??
      providers.find((p) => p.status === 'active') ??
      null;

    return {
      enabled: true,
      defaultSenderEmail: defaultSender?.email ?? sharedDefault?.email ?? null,
      defaultSenderName:
        defaultSender?.displayName ?? sharedDefault?.displayName ?? null,
      verifiedDomainCount: verifiedDomains.length,
      providerLabel: activeProvider?.provider ?? null,
    };
  }

  async enable(workspaceId: string) {
    const already = await this.repo.isEmailIntegrationEnabled(workspaceId);
    if (already) {
      return this.getStatus(workspaceId);
    }

    await assertChannelCreateAllowed(workspaceId);
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
