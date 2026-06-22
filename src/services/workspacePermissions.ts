import type { WorkspaceMemberRole } from './workspaceMemberAdmin.js';

export const WORKSPACE_PERMISSION_DEFS = [
  {
    key: 'inbox',
    label: 'Inbox & conversations',
    description: 'View and reply to conversations, canned responses, conversation tags',
  },
  {
    key: 'contacts',
    label: 'Contacts & CRM',
    description: 'Manage contacts, tags, attributes, and custom events',
  },
  {
    key: 'campaigns',
    label: 'Campaigns & journeys',
    description: 'Create and manage marketing campaigns and automations',
  },
  {
    key: 'ai',
    label: 'AI & automation',
    description: 'AI agents, copilot, and knowledge base settings',
  },
  {
    key: 'analytics',
    label: 'Analytics & reports',
    description: 'Dashboard metrics and team performance',
  },
  {
    key: 'settings',
    label: 'Workspace settings',
    description: 'Company info, security, holidays, and notifications',
  },
  {
    key: 'billing',
    label: 'Billing & subscription',
    description: 'Plans, payments, invoices, and add-ons',
  },
  {
    key: 'users',
    label: 'Users & teams',
    description: 'Add members and manage roles and permissions',
  },
  {
    key: 'integrations',
    label: 'Channels & integrations',
    description: 'WhatsApp, Instagram, Messenger, and connected channels',
  },
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSION_DEFS)[number]['key'];

export const ALL_WORKSPACE_PERMISSIONS: WorkspacePermission[] = WORKSPACE_PERMISSION_DEFS.map(
  (p) => p.key
);

/** Default access when an agent has no explicit permissions saved yet. */
export const DEFAULT_AGENT_PERMISSIONS: WorkspacePermission[] = ['inbox', 'contacts'];

export function isWorkspacePermission(value: string): value is WorkspacePermission {
  return (ALL_WORKSPACE_PERMISSIONS as string[]).includes(value);
}

export function normalizePermissions(input: unknown): WorkspacePermission[] {
  if (!Array.isArray(input)) return [];
  const unique = new Set<WorkspacePermission>();
  for (const item of input) {
    if (typeof item === 'string' && isWorkspacePermission(item)) {
      unique.add(item);
    }
  }
  return [...unique];
}

export function resolveEffectivePermissions(
  role: WorkspaceMemberRole,
  permissions: string[]
): WorkspacePermission[] {
  if (role === 'admin') return [...ALL_WORKSPACE_PERMISSIONS];
  const normalized = normalizePermissions(permissions);
  return normalized.length > 0 ? normalized : [...DEFAULT_AGENT_PERMISSIONS];
}

export function hasWorkspacePermission(
  role: WorkspaceMemberRole,
  permissions: string[],
  required: WorkspacePermission
): boolean {
  return resolveEffectivePermissions(role, permissions).includes(required);
}

export function settingsSectionPermission(section: string): WorkspacePermission | null {
  if (section === 'profile') return null;
  if (section === 'users') return 'users';
  if (['subscription', 'billing', 'recharge', 'invoices'].includes(section)) return 'billing';
  if (section.startsWith('contact-')) return 'contacts';
  if (['inbox-tags', 'canned-response', 'calling-tags'].includes(section)) return 'inbox';
  if (['ai-copilot', 'ai-knowledge'].includes(section)) return 'ai';
  if (['company-info', 'security', 'holidays', 'notifications'].includes(section)) {
    return 'settings';
  }
  return 'settings';
}
