import type { EmailProviderName } from '../types/email.types.js';
import { normalizeEmailProviderType } from '../types/provider-config.types.js';
import type {
  EmailProviderConfigType,
  ProviderConfigPayload,
  ProviderConnectionTestResult,
  ResendProviderConfig,
  SendGridProviderConfig,
  SesProviderConfig,
  SmtpProviderConfig,
} from '../types/provider-config.types.js';
import type { EmailProvider } from './email-provider.interface.js';
import { ResendProvider } from './resend.provider.js';
import { SesProvider } from './ses.provider.js';
import { SendGridProvider } from './sendgrid.provider.js';
import { SmtpProvider } from './smtp.provider.js';
import { config } from '../../../config.js';
import { decryptJson } from '../../../lib/field-encryption.js';

export type ResolvedEmailProvider = {
  provider: EmailProvider;
  configType: EmailProviderConfigType;
  configId: string;
  transportName: EmailProviderName;
};

export function configTypeToTransportName(type: EmailProviderConfigType): EmailProviderName {
  switch (type) {
    case 'CONVOSYNC_MANAGED':
    case 'WABIZ_MANAGED':
    case 'RESEND':
      return 'resend';
    case 'AWS_SES':
      return 'ses';
    case 'SENDGRID':
      return 'sendgrid';
    case 'SMTP':
      return 'smtp';
    default:
      return 'resend';
  }
}

export function supportsDomainManagement(type: EmailProviderConfigType): boolean {
  return type === 'CONVOSYNC_MANAGED' || type === 'WABIZ_MANAGED' || type === 'RESEND';
}

function parseConfig<T extends ProviderConfigPayload>(
  encryptedConfig: string
): T {
  if (!encryptedConfig) return {} as T;
  return decryptJson<T>(encryptedConfig);
}

export class EmailProviderFactory {
  buildFromType(
    type: EmailProviderConfigType,
    encryptedConfig: string
  ): EmailProvider {
    switch (type) {
      case 'CONVOSYNC_MANAGED':
      case 'WABIZ_MANAGED':
        return new ResendProvider(config.email.resendApiKey || undefined);
      case 'RESEND': {
        const cfg = parseConfig<ResendProviderConfig>(encryptedConfig);
        return new ResendProvider(cfg.apiKey);
      }
      case 'AWS_SES': {
        const cfg = parseConfig<SesProviderConfig>(encryptedConfig);
        return new SesProvider(cfg);
      }
      case 'SENDGRID': {
        const cfg = parseConfig<SendGridProviderConfig>(encryptedConfig);
        return new SendGridProvider(cfg);
      }
      case 'SMTP': {
        const cfg = parseConfig<SmtpProviderConfig>(encryptedConfig);
        return new SmtpProvider(cfg);
      }
      default:
        return new ResendProvider(config.email.resendApiKey || undefined);
    }
  }

  resolve(
    row: {
      id: string;
      provider: string;
      encryptedConfig: string;
    }
  ): ResolvedEmailProvider {
    const configType = normalizeEmailProviderType(row.provider);
    const provider = this.buildFromType(configType, row.encryptedConfig);
    return {
      provider,
      configType,
      configId: row.id,
      transportName: configTypeToTransportName(configType),
    };
  }

  async testConnection(
    type: EmailProviderConfigType,
    encryptedConfig: string
  ): Promise<ProviderConnectionTestResult> {
    const provider = this.buildFromType(type, encryptedConfig);
    return provider.testConnection();
  }
}

/** @deprecated Use EmailProviderFactory via container — kept for legacy env-only fallback. */
const legacyCache = new Map<EmailProviderName, EmailProvider>();

export function getEmailProvider(name: EmailProviderName = 'resend'): EmailProvider {
  const cached = legacyCache.get(name);
  if (cached) return cached;

  let provider: EmailProvider;
  switch (name) {
    case 'ses':
      provider = new SesProvider();
      break;
    case 'sendgrid':
      provider = new SendGridProvider();
      break;
    case 'smtp':
      provider = new SmtpProvider();
      break;
    case 'resend':
    default:
      provider = new ResendProvider();
      break;
  }
  legacyCache.set(name, provider);
  return provider;
}
