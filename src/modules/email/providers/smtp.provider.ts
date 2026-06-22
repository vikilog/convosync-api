import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { EmailProvider } from './email-provider.interface.js';
import type {
  CreateDomainResult,
  DomainStatusResult,
  SendEmailInput,
  SendEmailResult,
} from '../types/email.types.js';
import type { SmtpProviderConfig } from '../types/provider-config.types.js';

function domainNotSupported(): never {
  throw new Error(
    'Domain management is not available for SMTP. Configure DNS and sender addresses with your mail host.'
  );
}

export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  private transporter: Transporter | null;

  constructor(private readonly cfg: Partial<SmtpProviderConfig> = {}) {
    if (cfg.host && cfg.port) {
      this.transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure ?? cfg.port === 465,
        auth:
          cfg.username && cfg.password
            ? { user: cfg.username, pass: cfg.password }
            : undefined,
      });
    } else {
      this.transporter = null;
    }
  }

  private requireTransporter(): Transporter {
    if (!this.transporter) {
      throw new Error('SMTP credentials are not configured');
    }
    return this.transporter;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const transporter = this.requireTransporter();
      await transporter.verify();
      return { ok: true, message: 'SMTP connection successful' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'SMTP connection failed',
      };
    }
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const transporter = this.requireTransporter();
    const to = Array.isArray(input.to) ? input.to.join(', ') : input.to;
    const html = input.html ?? (input.text ? `<pre>${input.text}</pre>` : '<p></p>');

    const info = await transporter.sendMail({
      from: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
      to,
      subject: input.subject,
      html,
      text: input.text,
      replyTo: input.replyTo,
    });

    const messageId = info.messageId || `smtp-${Date.now()}`;
    return { messageId, provider: 'smtp' };
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
