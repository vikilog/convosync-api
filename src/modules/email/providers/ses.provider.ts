import {
  GetIdentityDkimAttributesCommand,
  GetIdentityVerificationAttributesCommand,
  GetSendQuotaCommand,
  SendEmailCommand,
  SESClient,
  VerifyDomainDkimCommand,
  VerifyDomainIdentityCommand,
} from '@aws-sdk/client-ses';
import { config } from '../../../config.js';
import type { EmailProvider } from './email-provider.interface.js';
import type {
  CreateDomainResult,
  DnsRecord,
  DomainStatusResult,
  EmailDomainStatus,
  SendEmailInput,
  SendEmailResult,
} from '../types/email.types.js';
import type { SesProviderConfig } from '../types/provider-config.types.js';

export function getPlatformSesConfig(): SesProviderConfig {
  return {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
    region: config.aws.region,
  };
}

export function isPlatformSesConfigured(): boolean {
  const cfg = getPlatformSesConfig();
  return Boolean(cfg.accessKeyId && cfg.secretAccessKey && cfg.region);
}

function resolveSesConfig(cfg: Partial<SesProviderConfig> = {}): SesProviderConfig | null {
  const accessKeyId = cfg.accessKeyId?.trim() || config.aws.accessKeyId;
  const secretAccessKey = cfg.secretAccessKey?.trim() || config.aws.secretAccessKey;
  const region = cfg.region?.trim() || config.aws.region;
  if (!accessKeyId || !secretAccessKey || !region) return null;
  return { accessKeyId, secretAccessKey, region };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapSesDomainStatus(
  verificationStatus: string | undefined,
  dkimStatus: string | undefined
): EmailDomainStatus {
  if (verificationStatus === 'Failed' || dkimStatus === 'Failed') return 'failed';
  if (verificationStatus === 'Success' && dkimStatus === 'Success') return 'verified';
  return 'pending';
}

function buildSesDnsRecords(
  domain: string,
  verificationToken: string,
  dkimTokens: string[],
  verificationStatus: string | undefined,
  dkimStatus: string | undefined
): DnsRecord[] {
  const txtVerified = verificationStatus === 'Success';
  const dkimVerified = dkimStatus === 'Success';

  const records: DnsRecord[] = [
    {
      type: 'TXT',
      name: `_amazonses.${domain}`,
      value: verificationToken,
      status: txtVerified ? 'verified' : verificationStatus === 'Failed' ? 'failed' : 'pending',
    },
    {
      type: 'SPF',
      name: domain,
      value: 'v=spf1 include:amazonses.com ~all',
      status: txtVerified ? 'verified' : 'pending',
    },
  ];

  for (const token of dkimTokens) {
    records.push({
      type: 'DKIM',
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
      status: dkimVerified ? 'verified' : dkimStatus === 'Failed' ? 'failed' : 'pending',
    });
  }

  return records;
}

export class SesProvider implements EmailProvider {
  readonly name = 'ses' as const;
  private client: SESClient | null;

  constructor(private readonly cfg: Partial<SesProviderConfig> = {}) {
    const resolved = resolveSesConfig(cfg);
    if (resolved) {
      this.client = new SESClient({
        region: resolved.region,
        credentials: {
          accessKeyId: resolved.accessKeyId,
          secretAccessKey: resolved.secretAccessKey,
        },
      });
    } else {
      this.client = null;
    }
  }

  private requireClient(): SESClient {
    if (!this.client) {
      throw new Error('AWS SES credentials are not configured');
    }
    return this.client;
  }

  private async fetchIdentityStatus(domain: string) {
    const client = this.requireClient();
    const [verificationRes, dkimRes] = await Promise.all([
      client.send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] })),
      client.send(new GetIdentityDkimAttributesCommand({ Identities: [domain] })),
    ]);

    const verification = verificationRes.VerificationAttributes?.[domain];
    const dkim = dkimRes.DkimAttributes?.[domain];
    const verificationStatus = verification?.VerificationStatus;
    const dkimStatus = dkim?.DkimVerificationStatus;
    const dkimTokens = dkim?.DkimTokens ?? [];
    const verificationToken = verification?.VerificationToken ?? '';

    return {
      verificationStatus,
      dkimStatus,
      dkimTokens,
      verificationToken,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const client = this.requireClient();
      await client.send(new GetSendQuotaCommand({}));
      return { ok: true, message: 'AWS SES connection successful' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'AWS SES connection failed',
      };
    }
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const client = this.requireClient();
    const to = Array.isArray(input.to) ? input.to : [input.to];
    const html = input.html ?? (input.text ? `<pre>${input.text}</pre>` : '<p></p>');

    const { MessageId } = await client.send(
      new SendEmailCommand({
        Source: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
        Destination: { ToAddresses: to },
        Message: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            ...(input.text ? { Text: { Data: input.text, Charset: 'UTF-8' } } : {}),
          },
        },
        ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
      })
    );

    if (!MessageId) {
      throw new Error('SES did not return a message id');
    }

    return { messageId: MessageId, provider: 'ses' };
  }

  async createDomain(domain: string): Promise<CreateDomainResult> {
    const client = this.requireClient();
    const normalized = domain.toLowerCase().trim();

    const { VerificationToken } = await client.send(
      new VerifyDomainIdentityCommand({ Domain: normalized })
    );
    if (!VerificationToken) {
      throw new Error('SES did not return a domain verification token');
    }

    const { DkimTokens } = await client.send(
      new VerifyDomainDkimCommand({ Domain: normalized })
    );

    const records = buildSesDnsRecords(
      normalized,
      VerificationToken,
      DkimTokens ?? [],
      'Pending',
      'Pending'
    );

    return { providerDomainId: normalized, records };
  }

  async verifyDomain(providerDomainId: string): Promise<DomainStatusResult> {
    const current = await this.getDomainStatus(providerDomainId);
    if (current.status === 'verified') {
      return current;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) await sleep(2000);
      const status = await this.getDomainStatus(providerDomainId);
      if (status.status === 'verified' || status.status === 'failed') {
        return status;
      }
    }

    return this.getDomainStatus(providerDomainId);
  }

  async getDomainStatus(providerDomainId: string): Promise<DomainStatusResult> {
    const domain = providerDomainId.toLowerCase().trim();
    const identity = await this.fetchIdentityStatus(domain);

    if (!identity.verificationToken && identity.verificationStatus !== 'Success') {
      throw new Error('Domain not found in AWS SES');
    }

    const records = buildSesDnsRecords(
      domain,
      identity.verificationToken,
      identity.dkimTokens,
      identity.verificationStatus,
      identity.dkimStatus
    );

    const status = mapSesDomainStatus(identity.verificationStatus, identity.dkimStatus);
    const spfVerified = identity.verificationStatus === 'Success';
    const dkimVerified = identity.dkimStatus === 'Success';

    return {
      status,
      records,
      spfVerified,
      dkimVerified,
      dmarcVerified: records.some((r) => r.type === 'DMARC' && r.status === 'verified'),
    };
  }
}
