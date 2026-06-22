import type {
  CreateDomainResult,
  DomainStatusResult,
  EmailProviderName,
  SendEmailInput,
  SendEmailResult,
} from '../types/email.types.js';
import type { ProviderConnectionTestResult } from '../types/provider-config.types.js';

/** Provider abstraction — business logic must not import Resend/SES directly. */
export interface EmailProvider {
  readonly name: EmailProviderName;

  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;

  testConnection(): Promise<ProviderConnectionTestResult>;

  createDomain(domain: string): Promise<CreateDomainResult>;

  verifyDomain(providerDomainId: string): Promise<DomainStatusResult>;

  getDomainStatus(providerDomainId: string): Promise<DomainStatusResult>;
}
