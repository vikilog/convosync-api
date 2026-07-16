import { Resend } from 'resend';
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

type ResendDomainRecord = {
  record?: string;
  name?: string;
  value?: string;
  type?: string;
  status?: string;
};

function mapRecordType(record: ResendDomainRecord): DnsRecord['type'] {
  const kind = (record.record ?? '').toUpperCase();
  if (kind === 'SPF') return 'SPF';
  if (kind === 'DKIM') return 'DKIM';
  if (kind === 'DMARC') return 'DMARC';

  const name = (record.name ?? '').toLowerCase();
  const value = (record.value ?? '').toLowerCase();
  if (name.includes('_dmarc') || value.includes('v=dmarc1')) return 'DMARC';
  if (name.includes('_domainkey') || name.includes('domainkey')) return 'DKIM';
  if (value.includes('v=spf1')) return 'SPF';
  if (record.type === 'MX') return 'MX';
  if (record.type === 'CNAME') return 'CNAME';
  return 'TXT';
}

function mapRecords(records: ResendDomainRecord[] | undefined): DnsRecord[] {
  if (!records?.length) return [];
  return records.map((r) => ({
    type: mapRecordType(r),
    name: r.name ?? '',
    value: r.value ?? '',
    status:
      r.status === 'verified'
        ? 'verified'
        : r.status === 'failed'
          ? 'failed'
          : 'pending',
  }));
}

function deriveVerificationFlags(records: DnsRecord[]): Pick<
  DomainStatusResult,
  'spfVerified' | 'dkimVerified' | 'dmarcVerified'
> {
  const isVerified = (type: DnsRecord['type']) =>
    records.some((r) => r.type === type && r.status === 'verified');
  return {
    spfVerified: isVerified('SPF'),
    dkimVerified: isVerified('DKIM'),
    dmarcVerified: isVerified('DMARC'),
  };
}

function mapResendStatus(status: string | undefined): EmailDomainStatus {
  if (status === 'verified') return 'verified';
  if (status === 'failed' || status === 'temporary_failure') return 'failed';
  return 'pending';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPlatformResendConfigured(): boolean {
  return Boolean(config.email.resendApiKey?.trim());
}

export class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private client: Resend | null;

  constructor(apiKey?: string) {
    const key = apiKey ?? config.email.resendApiKey;
    this.client = key ? new Resend(key) : null;
  }

  private requireClient(): Resend {
    if (!this.client) {
      throw new Error('RESEND_API_KEY is not configured');
    }
    return this.client;
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const client = this.requireClient();
    const from = input.fromName ? `${input.fromName} <${input.from}>` : input.from;
    const to = Array.isArray(input.to) ? input.to : [input.to];
    const html = input.html ?? (input.text ? `<pre>${input.text}</pre>` : '<p></p>');

    const { data, error } = await client.emails.send({
      from,
      to,
      subject: input.subject,
      html,
      text: input.text,
      replyTo: input.replyTo,
      tags: input.tags
        ? Object.entries(input.tags).map(([name, value]) => ({ name, value }))
        : undefined,
    });

    if (error) {
      throw new Error(error.message || 'Resend send failed');
    }
    if (!data?.id) {
      throw new Error('Resend did not return a message id');
    }

    return { messageId: data.id, provider: 'resend' };
  }

  async createDomain(domain: string): Promise<CreateDomainResult> {
    const client = this.requireClient();
    const { data, error } = await client.domains.create({ name: domain });
    if (error) throw new Error(error.message || 'Failed to create domain in Resend');
    if (!data?.id) throw new Error('Resend did not return domain id');

    const records = mapRecords(data.records as ResendDomainRecord[] | undefined);
    return { providerDomainId: data.id, records };
  }

  async verifyDomain(providerDomainId: string): Promise<DomainStatusResult> {
    const current = await this.getDomainStatus(providerDomainId);
    // Resend resets an already-verified domain to pending if verify is called again.
    if (current.status === 'verified') {
      return current;
    }

    const client = this.requireClient();
    const { error } = await client.domains.verify(providerDomainId);
    if (error) throw new Error(error.message || 'Domain verification request failed');

    // DNS may already be correct — poll until Resend finishes the check.
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
    const client = this.requireClient();
    const { data, error } = await client.domains.get(providerDomainId);
    if (error) throw new Error(error.message || 'Failed to fetch domain status');
    if (!data) throw new Error('Domain not found in Resend');

    const records = mapRecords(data.records as ResendDomainRecord[] | undefined);
    const flags = deriveVerificationFlags(records);
    const status = mapResendStatus(data.status);

    return {
      status,
      records,
      ...flags,
      dmarcVerified: flags.dmarcVerified || records.some((r) => r.type === 'DMARC'),
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const client = this.requireClient();
      const { error } = await client.domains.list();
      if (error) {
        return { ok: false, message: error.message || 'Resend connection failed' };
      }
      return { ok: true, message: 'Resend API key is valid' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Resend connection failed',
      };
    }
  }
}
