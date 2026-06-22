import {
  GetSendQuotaCommand,
  SendEmailCommand,
  SESClient,
} from '@aws-sdk/client-ses';
import type { EmailProvider } from './email-provider.interface.js';
import type {
  CreateDomainResult,
  DomainStatusResult,
  SendEmailInput,
  SendEmailResult,
} from '../types/email.types.js';
import type { SesProviderConfig } from '../types/provider-config.types.js';

function domainNotSupported(): never {
  throw new Error(
    'Domain management for AWS SES is not supported in ConvoSync yet. Verify identities in the AWS console.'
  );
}

export class SesProvider implements EmailProvider {
  readonly name = 'ses' as const;
  private client: SESClient | null;

  constructor(private readonly cfg: Partial<SesProviderConfig> = {}) {
    if (cfg.accessKeyId && cfg.secretAccessKey && cfg.region) {
      this.client = new SESClient({
        region: cfg.region,
        credentials: {
          accessKeyId: cfg.accessKeyId,
          secretAccessKey: cfg.secretAccessKey,
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
