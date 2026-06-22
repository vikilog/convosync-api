import sgMail from '@sendgrid/mail';
import type { EmailProvider } from './email-provider.interface.js';
import type {
  CreateDomainResult,
  DomainStatusResult,
  SendEmailInput,
  SendEmailResult,
} from '../types/email.types.js';
import type { SendGridProviderConfig } from '../types/provider-config.types.js';

function domainNotSupported(): never {
  throw new Error(
    'Domain management for SendGrid is not supported in ConvoSync yet. Authenticate domains in SendGrid.'
  );
}

export class SendGridProvider implements EmailProvider {
  readonly name = 'sendgrid' as const;
  private readonly apiKey: string | null;

  constructor(private readonly cfg: Partial<SendGridProviderConfig> = {}) {
    this.apiKey = cfg.apiKey?.trim() || null;
    if (this.apiKey) {
      sgMail.setApiKey(this.apiKey);
    }
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error('SendGrid API key is not configured');
    }
    return this.apiKey;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const key = this.requireApiKey();
      const res = await fetch('https://api.sendgrid.com/v3/user/profile', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, message: body || `SendGrid API returned ${res.status}` };
      }
      return { ok: true, message: 'SendGrid API key is valid' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'SendGrid connection failed',
      };
    }
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    this.requireApiKey();
    const to = Array.isArray(input.to) ? input.to : [input.to];
    const html = input.html ?? (input.text ? `<pre>${input.text}</pre>` : '<p></p>');

    const [response] = await sgMail.send({
      to,
      from: {
        email: input.from,
        name: input.fromName,
      },
      subject: input.subject,
      html,
      text: input.text,
      replyTo: input.replyTo,
    });

    const messageId =
      (response.headers['x-message-id'] as string | undefined) ??
      (response.headers['X-Message-Id'] as string | undefined) ??
      `sendgrid-${Date.now()}`;

    return { messageId, provider: 'sendgrid' };
  }

  createDomain(_domain: string): Promise<CreateDomainResult> {
    return Promise.reject(domainNotSupported());
  }

  verifyDomain(_providerDomainId: string): Promise<DomainStatusResult> {
    return Promise.reject(domainNotSupported());
  }

  getDomainStatus(_providerDomainId: string): Promise<DomainStatusResult> {
    return Promise.reject(domainNotSupported());
  }
}
