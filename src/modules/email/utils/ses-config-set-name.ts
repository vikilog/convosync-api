/**
 * SES configuration set names: letters, numbers, underscores, hyphens; max 64.
 */
export function sesConfigSetNameForWorkspace(workspaceId: string): string {
  const sanitized = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  const base = `convosync-${sanitized || 'ws'}`;
  return base.slice(0, 64);
}

export function sesSnsTopicNameForWorkspace(workspaceId: string): string {
  const sanitized = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const base = `convosync-email-${sanitized || 'ws'}`;
  return base.slice(0, 256);
}
