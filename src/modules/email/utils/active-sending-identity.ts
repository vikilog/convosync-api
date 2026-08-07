/**
 * Pick the From email shown as the workspace default.
 * Default EmailProviderConfig (e.g. AWS SES senderEmail) wins over platform shared.
 */
export function pickActiveSendingEmail(input: {
  defaultProviderType: string | null | undefined;
  defaultProviderStatus: string | null | undefined;
  defaultProviderSenderEmail: string | null | undefined;
  platformSharedEmail: string | null | undefined;
}): string | null {
  const type = (input.defaultProviderType ?? '').toUpperCase();
  const status = (input.defaultProviderStatus ?? '').toLowerCase();
  const providerSender = input.defaultProviderSenderEmail?.trim() || null;
  const platform = input.platformSharedEmail?.trim() || null;

  if (
    type === 'AWS_SES' &&
    status !== 'disabled' &&
    providerSender
  ) {
    return providerSender.toLowerCase();
  }

  return platform ? platform.toLowerCase() : null;
}

export function domainFromEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase() || '';
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return null;
  return e.slice(at + 1);
}
