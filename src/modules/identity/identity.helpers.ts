export function workspaceSlugFromName(name: string, now = Date.now()): string {
  return name.toLowerCase().replace(/\s+/g, '-') + '-' + now;
}

export type SessionAccess = {
  role: string;
  permissions: unknown;
  inboxScope: unknown;
};

export function sessionUserView(
  user: { id: string; name: string; email: string; avatar: string | null },
  access: SessionAccess,
  extra?: Record<string, unknown>
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    role: access.role,
    permissions: access.permissions,
    inboxScope: access.inboxScope,
    ...extra,
  };
}

export function normalizeCompanyEmail(email: unknown): string | null | undefined {
  if (email === undefined) return undefined;
  if (email === null || email === '') return null;
  return String(email).trim().toLowerCase();
}

export function normalizeCompanyPhone(phone: unknown): string | null | undefined {
  if (phone === undefined) return undefined;
  if (phone === null || phone === '') return null;
  return String(phone).replace(/\D/g, '');
}

/** Clear verifiedAt when the stored contact value changes. */
export function shouldClearVerifiedAt(prev: string | null, next: string | null): boolean {
  return next !== prev;
}
