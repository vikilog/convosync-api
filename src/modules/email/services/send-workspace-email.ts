import { prisma } from '../../../lib/prisma.js';
import { config } from '../../../config.js';
import type { EmailProvider } from '../providers/email-provider.interface.js';
import type { SendEmailInput, SendEmailResult } from '../types/email.types.js';
import { ResendProvider } from '../providers/resend.provider.js';
import { WorkspaceEmailConfigService } from './workspace-email-config.service.js';

export type WorkspaceEmailTransport = {
  kind: 'ses' | 'platform';
  provider: EmailProvider;
  defaultFrom: string;
  defaultFromName: string;
};

/**
 * Resolve outbound email transport for a workspace.
 * Active WorkspaceEmailConfig (SES) wins; otherwise platform Resend / env default.
 */
export async function resolveWorkspaceEmailTransport(
  workspaceId: string
): Promise<WorkspaceEmailTransport> {
  const service = new WorkspaceEmailConfigService(prisma);
  const ses = await service.resolveActiveSes(workspaceId);
  if (ses) {
    return {
      kind: 'ses',
      provider: ses.provider,
      defaultFrom: ses.from,
      defaultFromName: 'ConvoSync',
    };
  }

  return {
    kind: 'platform',
    provider: new ResendProvider(),
    defaultFrom: config.contactOtp.emailFrom,
    defaultFromName: 'ConvoSync',
  };
}

export type SendWorkspaceEmailInput = {
  workspaceId: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
};

/**
 * Single entry point for workspace-scoped transactional email
 * (alerts, invites, OTP, etc.). Campaigns with email integration
 * still go through EmailService for logging/billing, but prefer the
 * same SES resolution via getDefaultForSending.
 */
export async function sendWorkspaceEmail(
  input: SendWorkspaceEmailInput
): Promise<SendEmailResult & { transport: 'ses' | 'platform' }> {
  const transport = await resolveWorkspaceEmailTransport(input.workspaceId);
  const payload: SendEmailInput = {
    from: input.from ?? transport.defaultFrom,
    fromName: input.fromName ?? transport.defaultFromName,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
  };

  const result = await transport.provider.sendEmail(payload);
  return { ...result, transport: transport.kind };
}
