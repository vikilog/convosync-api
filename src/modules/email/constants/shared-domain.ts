import { config } from '../../../config.js';

export type SharedSenderDefinition = {
  email: string;
  displayName: string;
  isDefault: boolean;
};

/** Platform fallback senders — no custom domain required. */
export function getSharedSenderDefinitions(): SharedSenderDefinition[] {
  const domain = config.email.sharedDomain;
  return [
    { email: `noreply@${domain}`, displayName: 'ConvoSync', isDefault: true },
    { email: `support@${domain}`, displayName: 'ConvoSync Support', isDefault: false },
  ];
}

export function isSharedSenderEmail(email: string): boolean {
  const normalized = email.toLowerCase().trim();
  return getSharedSenderDefinitions().some((s) => s.email.toLowerCase() === normalized);
}
