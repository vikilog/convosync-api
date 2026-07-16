import { config } from '../../../config.js';

export type SharedSenderDefinition = {
  email: string;
  displayName: string;
  localPart: string;
  isDefault: boolean;
};

export type SharedSenderWorkspace = {
  slug: string;
  name: string;
};

/** Email-safe workspace token for shared From addresses. */
export function emailSlugFromWorkspace(slug: string, name?: string): string {
  const raw = (slug || name || 'workspace').toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'workspace';
}

/**
 * One platform sender per workspace: `{company}@{sharedDomain}`
 * e.g. acme@convosync.io
 */
export function getSharedSenderDefinitions(
  workspace?: SharedSenderWorkspace
): SharedSenderDefinition[] {
  const domain = config.email.sharedDomain;
  const company = workspace?.name?.trim() || 'ConvoSync';
  const token = workspace
    ? emailSlugFromWorkspace(workspace.slug, workspace.name)
    : 'noreply';

  return [
    {
      localPart: token,
      email: `${token}@${domain}`,
      displayName: company,
      isDefault: true,
    },
  ];
}

export function isSharedSenderEmail(email: string): boolean {
  const normalized = email.toLowerCase().trim();
  const at = normalized.lastIndexOf('@');
  if (at < 1) return false;

  const local = normalized.slice(0, at);
  const host = normalized.slice(at + 1);
  if (host !== config.email.sharedDomain.toLowerCase()) return false;
  if (!local || local.includes('..')) return false;

  // Company slug, legacy noreply/support, or noreply.acme / support.acme
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(local);
}
