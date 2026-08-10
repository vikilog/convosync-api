import type { EmailProviderConfig } from '@prisma/client';
import { decryptJson, encryptJson, hasEncryptedPayload } from '../../../lib/field-encryption.js';
import type { EmailRepository } from '../repositories/email.repository.js';
import {
  EmailProviderFactory,
} from '../providers/provider-factory.js';
import { isPlatformSesConfigured, SesProvider } from '../providers/ses.provider.js';
import { isPlatformResendConfigured } from '../providers/resend.provider.js';
import type {
  EmailProviderConfigPublic,
  EmailProviderConfigStatus,
  EmailProviderConfigType,
  ProviderConfigPayload,
  ResendProviderConfig,
  SendGridProviderConfig,
  SesProviderConfig,
  SmtpProviderConfig,
} from '../types/provider-config.types.js';
import { normalizeEmailProviderType } from '../types/provider-config.types.js';
import type { CreateProviderDto, UpdateProviderDto } from '../dto/email.dto.js';
import type { ResolvedEmailProvider } from '../providers/provider-factory.js';
import { WorkspaceEmailConfigService } from './workspace-email-config.service.js';
import { prisma } from '../../../lib/prisma.js';
import { formatSesSendError } from '../utils/ses-errors.js';
import {
  isSenderAllowedByIdentities,
  parseCachedVerifiedIdentities,
  sesVerifiedIdentitiesConsoleUrl,
  type SesVerifiedIdentity,
} from '../utils/ses-verified-identities.js';
import { ensureSesEventTracking } from './ses-tracking.service.js';

function isManagedProvider(provider: string): boolean {
  return normalizeEmailProviderType(provider) === 'CONVOSYNC_MANAGED';
}

function isPlatformManagedReady(): boolean {
  return isPlatformResendConfigured() || isPlatformSesConfigured();
}

function hasWorkspaceResendKey(encryptedConfig: string): boolean {
  if (!encryptedConfig) return false;
  try {
    const cfg = decryptJson<ResendProviderConfig>(encryptedConfig);
    return Boolean(cfg.apiKey?.trim());
  } catch {
    return false;
  }
}

function hasProviderCredentials(provider: string, encryptedConfig: string): boolean {
  if (isManagedProvider(provider)) return isPlatformManagedReady();
  const type = normalizeEmailProviderType(provider);
  if (type === 'RESEND') {
    return hasWorkspaceResendKey(encryptedConfig);
  }
  return hasEncryptedPayload(encryptedConfig);
}

function maskAccessKeyId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function readSesConfig(encryptedConfig: string): SesProviderConfig | null {
  if (!hasEncryptedPayload(encryptedConfig)) return null;
  try {
    return decryptJson<SesProviderConfig>(encryptedConfig);
  } catch {
    return null;
  }
}

function toPublic(row: EmailProviderConfig): EmailProviderConfigPublic {
  const provider = normalizeEmailProviderType(row.provider);
  const hasCredentials = hasProviderCredentials(row.provider, row.encryptedConfig);
  const base: EmailProviderConfigPublic = {
    id: row.id,
    workspaceId: row.workspaceId,
    provider,
    isDefault: row.isDefault,
    status: row.status as EmailProviderConfigStatus,
    hasCredentials,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (provider !== 'AWS_SES') return base;

  const ses = readSesConfig(row.encryptedConfig);
  const region = ses?.region?.trim() || null;
  return {
    ...base,
    region,
    senderEmail: ses?.senderEmail?.trim() || null,
    accessKeyIdMasked: maskAccessKeyId(ses?.accessKeyId),
    verifiedIdentities: parseCachedVerifiedIdentities(ses?.verifiedIdentities),
    identitiesFetchedAt: ses?.identitiesFetchedAt ?? null,
    sesConsoleUrl: region ? sesVerifiedIdentitiesConsoleUrl(region) : null,
    trackingStatus: ses?.trackingStatus ?? null,
    trackingError: ses?.trackingError ?? null,
    configurationSetName: ses?.configurationSetName ?? null,
  };
}

function validateConfigPayload(
  provider: EmailProviderConfigType,
  payload: ProviderConfigPayload
): void {
  switch (provider) {
    case 'CONVOSYNC_MANAGED':
      return;
    case 'RESEND': {
      const cfg = payload as ResendProviderConfig;
      if (!cfg.apiKey?.trim()) {
        throw new Error('Resend API key is required');
      }
      return;
    }
    case 'AWS_SES': {
      const cfg = payload as SesProviderConfig;
      if (!cfg.accessKeyId?.trim() || !cfg.secretAccessKey?.trim() || !cfg.region?.trim()) {
        throw new Error('AWS access key, secret key, and region are required');
      }
      return;
    }
    case 'SENDGRID':
      if (!(payload as SendGridProviderConfig).apiKey?.trim()) {
        throw new Error('SendGrid API key is required');
      }
      return;
    case 'SMTP': {
      const cfg = payload as SmtpProviderConfig;
      if (!cfg.host?.trim() || !cfg.port) {
        throw new Error('SMTP host and port are required');
      }
      return;
    }
    default:
      throw new Error('Unknown provider type');
  }
}

function mergeConfig(
  provider: EmailProviderConfigType,
  existing: ProviderConfigPayload,
  incoming: ProviderConfigPayload
): ProviderConfigPayload {
  switch (provider) {
    case 'CONVOSYNC_MANAGED':
      return {};
    case 'RESEND': {
      const next = incoming as Partial<ResendProviderConfig>;
      const prev = existing as ResendProviderConfig;
      return { apiKey: next.apiKey?.trim() || prev.apiKey };
    }
    case 'AWS_SES': {
      const next = incoming as Partial<SesProviderConfig>;
      const prev = existing as SesProviderConfig;
      return {
        accessKeyId: next.accessKeyId?.trim() || prev.accessKeyId,
        secretAccessKey: next.secretAccessKey?.trim() || prev.secretAccessKey,
        region: next.region?.trim() || prev.region,
        senderEmail:
          next.senderEmail !== undefined
            ? next.senderEmail?.trim() || undefined
            : prev.senderEmail,
        verifiedIdentities: next.verifiedIdentities ?? prev.verifiedIdentities,
        identitiesFetchedAt:
          next.identitiesFetchedAt !== undefined
            ? next.identitiesFetchedAt
            : prev.identitiesFetchedAt,
        configurationSetName: next.configurationSetName ?? prev.configurationSetName,
        snsTopicArn: next.snsTopicArn ?? prev.snsTopicArn,
        trackingStatus: next.trackingStatus ?? prev.trackingStatus,
        trackingError:
          next.trackingError !== undefined ? next.trackingError : prev.trackingError,
      };
    }
    case 'SENDGRID': {
      const next = incoming as Partial<SendGridProviderConfig>;
      const prev = existing as SendGridProviderConfig;
      return { apiKey: next.apiKey?.trim() || prev.apiKey };
    }
    case 'SMTP': {
      const next = incoming as Partial<SmtpProviderConfig>;
      const prev = existing as SmtpProviderConfig;
      return {
        host: next.host?.trim() || prev.host,
        port: next.port ?? prev.port,
        secure: next.secure ?? prev.secure,
        username: next.username?.trim() ?? prev.username,
        password: next.password?.trim() || prev.password,
      };
    }
    default:
      return incoming;
  }
}

function deriveInitialStatus(
  provider: EmailProviderConfigType,
  payload: ProviderConfigPayload
): EmailProviderConfigStatus {
  if (provider === 'CONVOSYNC_MANAGED') {
    return isPlatformManagedReady() ? 'active' : 'credentials_missing';
  }
  if (provider === 'RESEND') {
    const cfg = payload as ResendProviderConfig;
    if (cfg.apiKey?.trim()) return 'active';
    return 'credentials_missing';
  }
  try {
    validateConfigPayload(provider, payload);
    return 'active';
  } catch {
    return 'credentials_missing';
  }
}

export class EmailProviderConfigService {
  constructor(
    private readonly repo: EmailRepository,
    private readonly factory: EmailProviderFactory
  ) {}

  /**
   * Ensures every workspace has the opaque ConvoSync platform provider.
   * Underlying transport (Resend/SES) stays server-side only.
   */
  async ensureWorkspaceProviders(workspaceId: string): Promise<EmailProviderConfig[]> {
    let existing = await this.repo.listProviderConfigs(workspaceId);

    // Platform-seeded RESEND (no workspace API key) → CONVOSYNC_MANAGED so tenants never see Resend.
    for (const row of existing) {
      if (
        normalizeEmailProviderType(row.provider) === 'RESEND' &&
        !hasWorkspaceResendKey(row.encryptedConfig)
      ) {
        await this.repo.updateProviderConfig(row.id, {
          provider: 'CONVOSYNC_MANAGED',
          encryptedConfig: encryptJson({}),
          status: isPlatformManagedReady() ? 'active' : 'credentials_missing',
        });
      }
    }
    existing = await this.repo.listProviderConfigs(workspaceId);

    // Heal: active BYO SES that isn't default still syncs WorkspaceEmailConfig → client
    // pays AWS but wallet was metered as platform. Promote SES to default once.
    const activeSes = existing.find(
      (r) => normalizeEmailProviderType(r.provider) === 'AWS_SES' && r.status === 'active'
    );
    if (activeSes && !activeSes.isDefault) {
      await this.repo.clearDefaultProviderConfigs(workspaceId, activeSes.id);
      await this.repo.updateProviderConfig(activeSes.id, { isDefault: true });
      existing = await this.repo.listProviderConfigs(workspaceId);
    }

    if (existing.length > 0) return existing;

    const row = await this.repo.createProviderConfig({
      provider: 'CONVOSYNC_MANAGED',
      isDefault: true,
      status: isPlatformManagedReady() ? 'active' : 'credentials_missing',
      encryptedConfig: encryptJson({}),
      workspace: { connect: { id: workspaceId } },
    });
    return [row];
  }

  async listProviders(workspaceId: string): Promise<EmailProviderConfigPublic[]> {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      return [];
    }
    const rows = await this.ensureWorkspaceProviders(workspaceId);
    return rows.map(toPublic);
  }

  /**
   * Default provider's From when BYO (AWS SES). Null → use platform shared sender.
   */
  async getDefaultProviderSender(
    workspaceId: string
  ): Promise<{
    email: string;
    provider: EmailProviderConfigType;
    status: EmailProviderConfigStatus;
  } | null> {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      return null;
    }
    await this.ensureWorkspaceProviders(workspaceId);
    const row = await this.repo.findDefaultProviderConfig(workspaceId);
    if (!row) return null;
    const provider = normalizeEmailProviderType(row.provider);
    const status = row.status as EmailProviderConfigStatus;
    if (provider !== 'AWS_SES' || status === 'disabled') return null;
    const ses = readSesConfig(row.encryptedConfig);
    const email = ses?.senderEmail?.trim();
    if (!email) return null;
    return { email, provider, status };
  }

  async getDefaultForSending(workspaceId: string): Promise<ResolvedEmailProvider & { row: EmailProviderConfig }> {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }

    // Campaigns / Integrations sends follow the Providers tab default only.
    // Transactional alerts still use WorkspaceEmailConfig (synced from SES provider save).
    await this.ensureWorkspaceProviders(workspaceId);
    const row = await this.repo.findDefaultProviderConfig(workspaceId);
    if (!row) {
      throw new Error('No email provider configured for this workspace');
    }
    if (row.status === 'disabled') {
      throw new Error('Email provider is disabled');
    }
    if (row.status === 'credentials_missing') {
      throw new Error('Email provider credentials are missing');
    }
    if (row.status === 'connection_failed') {
      throw new Error('Email provider connection failed — run Test Connection or update credentials');
    }

    const resolved = this.factory.resolve(row);
    return { ...resolved, row };
  }

  private async syncWorkspaceSesFromRow(row: EmailProviderConfig): Promise<void> {
    if (normalizeEmailProviderType(row.provider) !== 'AWS_SES') return;
    const ses = readSesConfig(row.encryptedConfig);
    if (!ses?.accessKeyId || !ses.secretAccessKey || !ses.region) return;
    await new WorkspaceEmailConfigService(prisma).syncFromSesProvider(row.workspaceId, {
      active: row.status === 'active',
      accessKeyId: ses.accessKeyId,
      secretAccessKey: ses.secretAccessKey,
      region: ses.region,
      senderEmail: ses.senderEmail,
      verifiedIdentities: parseCachedVerifiedIdentities(ses.verifiedIdentities),
      identitiesFetchedAt: ses.identitiesFetchedAt ? new Date(ses.identitiesFetchedAt) : null,
    });
  }

  /**
   * Best-effort SES config-set + SNS webhook setup. Persist trackingStatus/error on the
   * provider; never blocks credential save — sends work without ConfigurationSetName.
   */
  private async setupSesTrackingOnRow(row: EmailProviderConfig): Promise<EmailProviderConfig> {
    const ses = readSesConfig(row.encryptedConfig);
    if (!ses?.accessKeyId || !ses.secretAccessKey || !ses.region) return row;

    const tracking = await ensureSesEventTracking({
      workspaceId: row.workspaceId,
      accessKeyId: ses.accessKeyId,
      secretAccessKey: ses.secretAccessKey,
      region: ses.region,
      existingConfigurationSetName: ses.configurationSetName,
      existingSnsTopicArn: ses.snsTopicArn,
    });

    const next: SesProviderConfig = {
      ...ses,
      configurationSetName: tracking.configurationSetName ?? ses.configurationSetName,
      snsTopicArn: tracking.ok ? tracking.snsTopicArn : ses.snsTopicArn,
      trackingStatus: tracking.trackingStatus,
      trackingError: tracking.ok ? null : tracking.trackingError,
    };

    return this.repo.updateProviderConfig(row.id, { encryptedConfig: encryptJson(next) });
  }

  async getDomainManagementProvider(workspaceId: string): Promise<ResolvedEmailProvider> {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    await this.ensureWorkspaceProviders(workspaceId);
    const rows = await this.repo.listProviderConfigs(workspaceId);
    const domainRow =
      rows.find((r) => isManagedProvider(r.provider)) ??
      rows.find((r) => {
        const type = normalizeEmailProviderType(r.provider);
        return type === 'RESEND' || type === 'AWS_SES';
      });

    if (!domainRow) {
      throw new Error(
        'Domain verification requires ConvoSync platform email, or a Resend / AWS SES provider'
      );
    }
    if (domainRow.status !== 'active') {
      throw new Error('Email provider is not active');
    }
    return this.factory.resolve(domainRow);
  }

  /** @deprecated Use getDomainManagementProvider */
  async getResendBackedProvider(workspaceId: string): Promise<ResolvedEmailProvider> {
    return this.getDomainManagementProvider(workspaceId);
  }

  private assertSesSender(payload: SesProviderConfig): void {
    const sender = payload.senderEmail?.trim();
    if (!sender) return;
    const identities = parseCachedVerifiedIdentities(payload.verifiedIdentities);
    if (identities.length > 0 && !isSenderAllowedByIdentities(sender, identities)) {
      throw new Error(
        'From email must match a verified SES email identity or a verified domain'
      );
    }
  }

  async createProvider(workspaceId: string, input: CreateProviderDto) {
    await this.ensureWorkspaceProviders(workspaceId);
    const existing = await this.repo.findProviderConfigByType(workspaceId, input.provider);
    if (existing) {
      throw new Error(`${input.provider} provider already exists for this workspace`);
    }

    const payload = (input.config ?? {}) as ProviderConfigPayload;
    validateConfigPayload(input.provider, payload);
    if (input.provider === 'AWS_SES') {
      this.assertSesSender(payload as SesProviderConfig);
    }

    // BYO (SES/etc.) always becomes default on create — otherwise CONVOSYNC_MANAGED
    // stays default and platform CC metering still applies while mail goes via BYO From.
    const isByo = input.provider !== 'CONVOSYNC_MANAGED';
    const isDefault = isByo ? true : Boolean(input.isDefault);

    if (isDefault) {
      await this.repo.clearDefaultProviderConfigs(workspaceId);
    }

    const encryptedConfig =
      input.provider === 'CONVOSYNC_MANAGED' ? encryptJson({}) : encryptJson(payload);

    const row = await this.repo.createProviderConfig({
      provider: input.provider,
      isDefault,
      status: deriveInitialStatus(input.provider, payload),
      encryptedConfig,
      workspace: { connect: { id: workspaceId } },
    });

    if (input.provider === 'AWS_SES') {
      const withTracking = await this.setupSesTrackingOnRow(row);
      await this.syncWorkspaceSesFromRow(withTracking);
      return toPublic(withTracking);
    }

    return toPublic(row);
  }

  async updateProvider(workspaceId: string, id: string, input: UpdateProviderDto) {
    const row = await this.repo.findProviderConfigById(workspaceId, id);
    if (!row) throw new Error('Provider not found');

    const provider = normalizeEmailProviderType(row.provider);
    const existingPayload = hasEncryptedPayload(row.encryptedConfig)
      ? decryptJson<ProviderConfigPayload>(row.encryptedConfig)
      : ({} as ProviderConfigPayload);

    let encryptedConfig = row.encryptedConfig;
    if (input.config && provider !== 'CONVOSYNC_MANAGED') {
      const merged = mergeConfig(provider, existingPayload, input.config as ProviderConfigPayload);
      validateConfigPayload(provider, merged);
      if (provider === 'AWS_SES') {
        this.assertSesSender(merged as SesProviderConfig);
      }
      encryptedConfig = encryptJson(merged);
    }

    if (input.isDefault) {
      await this.repo.clearDefaultProviderConfigs(workspaceId, id);
    }

    const updated = await this.repo.updateProviderConfig(id, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      ...(encryptedConfig !== row.encryptedConfig ? { encryptedConfig } : {}),
    });

    if (provider === 'AWS_SES') {
      const withTracking =
        encryptedConfig !== row.encryptedConfig
          ? await this.setupSesTrackingOnRow(updated)
          : updated;
      await this.syncWorkspaceSesFromRow(withTracking);
      return toPublic(withTracking);
    }

    return toPublic(updated);
  }

  async deleteProvider(workspaceId: string, id: string) {
    const row = await this.repo.findProviderConfigById(workspaceId, id);
    if (!row) throw new Error('Provider not found');

    const all = await this.repo.listProviderConfigs(workspaceId);
    if (all.length <= 1) {
      throw new Error('Cannot delete the only email provider');
    }

    const wasSes = normalizeEmailProviderType(row.provider) === 'AWS_SES';
    await this.repo.deleteProviderConfig(id);

    if (wasSes) {
      await new WorkspaceEmailConfigService(prisma).disable(workspaceId);
    }

    if (row.isDefault) {
      const remaining = await this.repo.listProviderConfigs(workspaceId);
      const fallback =
        remaining.find((r) => normalizeEmailProviderType(r.provider) === 'RESEND') ??
        remaining[0];
      if (fallback) {
        await this.repo.updateProviderConfig(fallback.id, { isDefault: true });
      }
    }
  }

  async setDefaultProvider(workspaceId: string, id: string) {
    const row = await this.repo.findProviderConfigById(workspaceId, id);
    if (!row) throw new Error('Provider not found');
    if (row.status === 'disabled') {
      throw new Error('Cannot set a disabled provider as default');
    }

    await this.repo.clearDefaultProviderConfigs(workspaceId, id);
    const updated = await this.repo.updateProviderConfig(id, { isDefault: true });
    // Keep WorkspaceEmailConfig aligned with Providers-tab default (source of truth).
    if (normalizeEmailProviderType(updated.provider) === 'AWS_SES') {
      await this.syncWorkspaceSesFromRow(updated);
    } else {
      await new WorkspaceEmailConfigService(prisma).disable(workspaceId);
    }
    return toPublic(updated);
  }

  async testProviderConnection(workspaceId: string, id: string) {
    const row = await this.repo.findProviderConfigById(workspaceId, id);
    if (!row) throw new Error('Provider not found');

    const providerType = normalizeEmailProviderType(row.provider);
    const result = await this.factory.testConnection(
      providerType,
      row.encryptedConfig
    );

    const nextStatus: EmailProviderConfigStatus = result.ok ? 'active' : 'connection_failed';
    let updated = await this.repo.updateProviderConfig(id, { status: nextStatus });
    if (providerType === 'AWS_SES' && result.ok) {
      updated = await this.setupSesTrackingOnRow(updated);
      await this.syncWorkspaceSesFromRow(updated);
      const tracking = readSesConfig(updated.encryptedConfig);
      if (tracking?.trackingStatus === 'error' && tracking.trackingError) {
        return {
          ok: true,
          message: `${result.message}. ${tracking.trackingError}`,
        };
      }
    } else if (providerType === 'AWS_SES') {
      await this.syncWorkspaceSesFromRow(updated);
    }

    return result;
  }

  private resolveSesDraft(
    stored: SesProviderConfig | null,
    draft: Partial<SesProviderConfig> = {}
  ):
    | { ok: true; accessKeyId: string; secretAccessKey: string; region: string }
    | { ok: false; message: string } {
    const accessKeyId = draft.accessKeyId?.trim() || stored?.accessKeyId?.trim() || '';
    const secretAccessKey =
      draft.secretAccessKey?.trim() || stored?.secretAccessKey?.trim() || '';
    const region = draft.region?.trim() || stored?.region?.trim() || '';
    if (!accessKeyId || !secretAccessKey || !region) {
      return {
        ok: false,
        message: 'AWS Access Key ID, Secret Access Key, and Region are required.',
      };
    }
    return { ok: true, accessKeyId, secretAccessKey, region };
  }

  /**
   * List SES verified identities. With providerId, persists cache on the provider
   * (and syncs WorkspaceEmailConfig). Without id, preview-only for the Add form.
   */
  async refreshSesIdentities(
    workspaceId: string,
    opts: { providerId?: string; draft?: Partial<SesProviderConfig> } = {}
  ): Promise<
    | {
        ok: true;
        message: string;
        verifiedIdentities: SesVerifiedIdentity[];
        identitiesFetchedAt: string;
        provider?: EmailProviderConfigPublic;
      }
    | {
        ok: false;
        message: string;
        verifiedIdentities: SesVerifiedIdentity[];
        provider?: EmailProviderConfigPublic;
      }
  > {
    let row: EmailProviderConfig | null = null;
    let stored: SesProviderConfig | null = null;

    if (opts.providerId) {
      row = await this.repo.findProviderConfigById(workspaceId, opts.providerId);
      if (!row) throw new Error('Provider not found');
      if (normalizeEmailProviderType(row.provider) !== 'AWS_SES') {
        throw new Error('Only AWS SES providers support identity refresh');
      }
      stored = readSesConfig(row.encryptedConfig);
    }

    const creds = this.resolveSesDraft(stored, opts.draft);
    if (!creds.ok) {
      return {
        ok: false,
        message: creds.message,
        verifiedIdentities: parseCachedVerifiedIdentities(stored?.verifiedIdentities),
        provider: row ? toPublic(row) : undefined,
      };
    }

    const ses = new SesProvider({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      region: creds.region,
    });

    try {
      const quota = await ses.testConnection();
      if (!quota.ok) {
        return {
          ok: false,
          message: quota.message,
          verifiedIdentities: parseCachedVerifiedIdentities(stored?.verifiedIdentities),
          provider: row ? toPublic(row) : undefined,
        };
      }

      const verifiedIdentities = await ses.listVerifiedIdentities();
      const identitiesFetchedAt = new Date().toISOString();
      const domainCount = verifiedIdentities.filter((i) => i.type === 'domain').length;
      const emailCount = verifiedIdentities.filter((i) => i.type === 'email').length;
      const message =
        verifiedIdentities.length === 0
          ? `No verified domains or emails in region ${creds.region} — verify a sender domain/email in SES (same region), then refresh`
          : `Found ${verifiedIdentities.length} verified sender identit${
              verifiedIdentities.length === 1 ? 'y' : 'ies'
            } (${domainCount} domain${domainCount === 1 ? '' : 's'}, ${emailCount} email${
              emailCount === 1 ? '' : 's'
            })`;

      if (!row) {
        return { ok: true, message, verifiedIdentities, identitiesFetchedAt };
      }

      const nextConfig: SesProviderConfig = {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        region: creds.region,
        senderEmail: opts.draft?.senderEmail?.trim() || stored?.senderEmail,
        verifiedIdentities,
        identitiesFetchedAt,
        configurationSetName: stored?.configurationSetName,
        snsTopicArn: stored?.snsTopicArn,
        trackingStatus: stored?.trackingStatus,
        trackingError: stored?.trackingError,
      };
      let updated = await this.repo.updateProviderConfig(row.id, {
        encryptedConfig: encryptJson(nextConfig),
        status: row.status === 'disabled' ? 'disabled' : 'active',
      });
      updated = await this.setupSesTrackingOnRow(updated);
      await this.syncWorkspaceSesFromRow(updated);
      const publicProvider = toPublic(updated);
      const trackingNote =
        publicProvider.trackingStatus === 'error' && publicProvider.trackingError
          ? ` ${publicProvider.trackingError}`
          : '';

      return {
        ok: true,
        message: `${message}.${trackingNote}`.trim(),
        verifiedIdentities,
        identitiesFetchedAt,
        provider: publicProvider,
      };
    } catch (err) {
      return {
        ok: false,
        message: formatSesSendError(err),
        verifiedIdentities: parseCachedVerifiedIdentities(stored?.verifiedIdentities),
        provider: row ? toPublic(row) : undefined,
      };
    }
  }

  async testSesSend(
    workspaceId: string,
    opts: {
      to: string;
      providerId?: string;
      draft?: Partial<SesProviderConfig>;
    }
  ): Promise<
    | {
        ok: true;
        message: string;
        messageId: string;
        verifiedIdentities: SesVerifiedIdentity[];
        provider?: EmailProviderConfigPublic;
      }
    | {
        ok: false;
        message: string;
        verifiedIdentities?: SesVerifiedIdentity[];
        provider?: EmailProviderConfigPublic;
      }
  > {
    const refreshed = await this.refreshSesIdentities(workspaceId, {
      providerId: opts.providerId,
      draft: opts.draft,
    });
    if (!refreshed.ok) {
      return {
        ok: false,
        message: refreshed.message,
        verifiedIdentities: refreshed.verifiedIdentities,
        provider: refreshed.provider,
      };
    }

    let stored: SesProviderConfig | null = null;
    if (opts.providerId) {
      const row = await this.repo.findProviderConfigById(workspaceId, opts.providerId);
      stored = row ? readSesConfig(row.encryptedConfig) : null;
    }
    const creds = this.resolveSesDraft(stored, opts.draft);
    if (!creds.ok) {
      return { ok: false, message: creds.message, provider: refreshed.provider };
    }

    const senderEmail =
      opts.draft?.senderEmail?.trim() || stored?.senderEmail?.trim() || '';
    if (!senderEmail) {
      return {
        ok: false,
        message: 'From email is required to send a test. Refresh identities and pick a sender.',
        verifiedIdentities: refreshed.verifiedIdentities,
        provider: refreshed.provider,
      };
    }

    if (
      refreshed.verifiedIdentities.length > 0 &&
      !isSenderAllowedByIdentities(senderEmail, refreshed.verifiedIdentities)
    ) {
      return {
        ok: false,
        message:
          'From email must match a verified SES email identity or a verified domain. Refresh identities and pick a verified sender.',
        verifiedIdentities: refreshed.verifiedIdentities,
        provider: refreshed.provider,
      };
    }

    // Prefer tracking-enabled config from saved provider (refresh may have just set it up).
    let trackingCfg: Pick<
      SesProviderConfig,
      'configurationSetName' | 'trackingStatus'
    > = {};
    if (opts.providerId) {
      const row = await this.repo.findProviderConfigById(workspaceId, opts.providerId);
      const cfg = row ? readSesConfig(row.encryptedConfig) : null;
      if (cfg) {
        trackingCfg = {
          configurationSetName: cfg.configurationSetName,
          trackingStatus: cfg.trackingStatus,
        };
      }
    }

    const ses = new SesProvider({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      region: creds.region,
      ...trackingCfg,
    });
    try {
      const result = await ses.sendEmail({
        from: senderEmail,
        fromName: 'ConvoSync',
        to: opts.to,
        subject: 'ConvoSync SES test email',
        text:
          `This is a test email from ConvoSync using your AWS SES credentials.\n\n` +
          `Region: ${creds.region}\nSender: ${senderEmail}\n\n` +
          `If you received this, your AWS SES provider setup is working.`,
      });
      const trackingWarn =
        refreshed.provider?.trackingStatus === 'error' && refreshed.provider.trackingError
          ? ` (${refreshed.provider.trackingError})`
          : '';
      return {
        ok: true,
        message: `Test email sent to ${opts.to}${trackingWarn}`,
        messageId: result.messageId,
        verifiedIdentities: refreshed.verifiedIdentities,
        provider: refreshed.provider,
      };
    } catch (err) {
      return {
        ok: false,
        message: formatSesSendError(err),
        verifiedIdentities: refreshed.verifiedIdentities,
        provider: refreshed.provider,
      };
    }
  }
}
