import type { EmailProviderConfig } from '@prisma/client';
import { config } from '../../../config.js';
import { decryptJson, encryptJson, hasEncryptedPayload } from '../../../lib/field-encryption.js';
import type { EmailRepository } from '../repositories/email.repository.js';
import {
  EmailProviderFactory,
} from '../providers/provider-factory.js';
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

function isManagedProvider(provider: string): boolean {
  return normalizeEmailProviderType(provider) === 'CONVOSYNC_MANAGED';
}

function toPublic(row: EmailProviderConfig): EmailProviderConfigPublic {
  const provider = normalizeEmailProviderType(row.provider);
  const hasCredentials = isManagedProvider(row.provider)
      ? Boolean(config.email.resendApiKey)
      : hasEncryptedPayload(row.encryptedConfig);

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider,
    isDefault: row.isDefault,
    status: row.status as EmailProviderConfigStatus,
    hasCredentials,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateConfigPayload(
  provider: EmailProviderConfigType,
  payload: ProviderConfigPayload
): void {
  switch (provider) {
    case 'CONVOSYNC_MANAGED':
      return;
    case 'RESEND':
      if (!(payload as ResendProviderConfig).apiKey?.trim()) {
        throw new Error('Resend API key is required');
      }
      return;
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
    return config.email.resendApiKey ? 'active' : 'credentials_missing';
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

  /** Ensures existing workspaces keep ConvoSync Managed Resend without manual setup. */
  async ensureWorkspaceProviders(workspaceId: string): Promise<EmailProviderConfig[]> {
    const existing = await this.repo.listProviderConfigs(workspaceId);
    if (existing.length > 0) return existing;

    const row = await this.repo.createProviderConfig({
      provider: 'CONVOSYNC_MANAGED',
      isDefault: true,
      status: config.email.resendApiKey ? 'active' : 'credentials_missing',
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

  async getDefaultForSending(workspaceId: string): Promise<ResolvedEmailProvider & { row: EmailProviderConfig }> {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
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

  async getResendBackedProvider(workspaceId: string): Promise<ResolvedEmailProvider> {
    if (!(await this.repo.isEmailIntegrationEnabled(workspaceId))) {
      throw new Error('Email integration is not enabled for this workspace');
    }
    await this.ensureWorkspaceProviders(workspaceId);
    const rows = await this.repo.listProviderConfigs(workspaceId);
    const resendRow =
      rows.find((r) => isManagedProvider(r.provider)) ??
      rows.find((r) => r.provider === 'RESEND');

    if (!resendRow) {
      throw new Error(
        'Domain verification requires ConvoSync Managed or a Resend BYOP provider'
      );
    }
    if (resendRow.status !== 'active') {
      throw new Error('Resend provider is not active');
    }
    return this.factory.resolve(resendRow);
  }

  async createProvider(workspaceId: string, input: CreateProviderDto) {
    await this.ensureWorkspaceProviders(workspaceId);
    const existing = await this.repo.findProviderConfigByType(workspaceId, input.provider);
    if (existing) {
      throw new Error(`${input.provider} provider already exists for this workspace`);
    }

    const payload = (input.config ?? {}) as ProviderConfigPayload;
    validateConfigPayload(input.provider, payload);

    if (input.isDefault) {
      await this.repo.clearDefaultProviderConfigs(workspaceId);
    }

    const hasAny = await this.repo.listProviderConfigs(workspaceId);
    const isDefault = input.isDefault ?? hasAny.length === 0;

    const encryptedConfig =
      input.provider === 'CONVOSYNC_MANAGED' ? encryptJson({}) : encryptJson(payload);

    const row = await this.repo.createProviderConfig({
      provider: input.provider,
      isDefault,
      status: deriveInitialStatus(input.provider, payload),
      encryptedConfig,
      workspace: { connect: { id: workspaceId } },
    });

    return toPublic(row);
  }

  async updateProvider(workspaceId: string, id: string, input: UpdateProviderDto) {
    const row = await this.repo.findProviderConfigById(workspaceId, id);
    if (!row) throw new Error('Provider not found');

    const provider = row.provider as EmailProviderConfigType;
    const existingPayload = hasEncryptedPayload(row.encryptedConfig)
      ? decryptJson<ProviderConfigPayload>(row.encryptedConfig)
      : ({} as ProviderConfigPayload);

    let encryptedConfig = row.encryptedConfig;
    if (input.config && provider !== 'CONVOSYNC_MANAGED') {
      const merged = mergeConfig(provider, existingPayload, input.config as ProviderConfigPayload);
      validateConfigPayload(provider, merged);
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

    return toPublic(updated);
  }

  async deleteProvider(workspaceId: string, id: string) {
    const row = await this.repo.findProviderConfigById(workspaceId, id);
    if (!row) throw new Error('Provider not found');

    const all = await this.repo.listProviderConfigs(workspaceId);
    if (all.length <= 1) {
      throw new Error('Cannot delete the only email provider');
    }

    await this.repo.deleteProviderConfig(id);

    if (row.isDefault) {
      const remaining = await this.repo.listProviderConfigs(workspaceId);
      const fallback =
        remaining.find((r) => r.provider === 'CONVOSYNC_MANAGED') ?? remaining[0];
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
    return toPublic(updated);
  }

  async testProviderConnection(workspaceId: string, id: string) {
    const row = await this.repo.findProviderConfigById(workspaceId, id);
    if (!row) throw new Error('Provider not found');

    const providerType = row.provider as EmailProviderConfigType;
    const result = await this.factory.testConnection(
      providerType,
      row.encryptedConfig
    );

    const nextStatus: EmailProviderConfigStatus = result.ok ? 'active' : 'connection_failed';
    await this.repo.updateProviderConfig(id, { status: nextStatus });

    return result;
  }
}
