import type { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { isValidIanaTimeZone } from '../../services/geoip/index.js';
import { onboardingPayloadFromUser } from '../../services/onboarding.js';
import { newCustomerTrialFields, serializeTrialInfo } from '../../services/trial.js';
import { sanitizeUser } from '../../services/userProfile.js';
import { grantSignupWalletCredit } from '../../services/wallet.service.js';
import { listWhatsAppAccounts } from '../../services/whatsappAccounts.js';
import { resolveMembershipAccess } from '../../services/workspaceMemberAdmin.js';
import {
  ensureUserMemberships,
  listUserWorkspaces,
  userHasWorkspaceAccess,
} from '../../services/workspaceMembership.js';
import {
  normalizeCompanyEmail,
  normalizeCompanyPhone,
  shouldClearVerifiedAt,
  workspaceSlugFromName,
} from './identity.helpers.js';
import * as identityRepo from './identity.repository.js';

export async function registerAccount(input: {
  name: string;
  email: string;
  password: string;
  workspaceName?: string;
}) {
  const email = input.email.trim().toLowerCase();
  const existing = await identityRepo.findUserByEmail(email);
  if (existing) return { ok: false as const, status: 409 as const, error: 'Email already registered' };

  const placeholderWorkspaceName = input.workspaceName?.trim() || `${input.name.trim()}'s Workspace`;
  const workspace = await identityRepo.createWorkspace({
    name: placeholderWorkspaceName,
    slug: workspaceSlugFromName(placeholderWorkspaceName),
    email,
    ...newCustomerTrialFields(),
  });

  const user = await identityRepo.createSignupUser({
    name: input.name,
    email,
    password: await bcrypt.hash(input.password, 12),
    workspaceId: workspace.id,
  });

  await grantSignupWalletCredit(workspace.id);
  const workspaces = await listUserWorkspaces(user.id);
  return { ok: true as const, user, workspace, workspaces };
}

export async function verifyLoginCredentials(email: string, password: string) {
  const user = await identityRepo.findUserByEmailWithWorkspace(email.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return { ok: false as const };
  }
  return { ok: true as const, user };
}

export async function resolveLoginWorkspace(
  user: { id: string; workspaceId: string; workspace: unknown },
  requestedWorkspaceId?: string
) {
  const workspaces = await listUserWorkspaces(user.id);
  let activeWorkspaceId = user.workspaceId;

  if (requestedWorkspaceId) {
    const allowed = await userHasWorkspaceAccess(user.id, requestedWorkspaceId);
    if (!allowed) return { ok: false as const, status: 403 as const, error: 'No access to this company' };
    activeWorkspaceId = requestedWorkspaceId;
  }

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  if (activeWorkspace) activeWorkspaceId = activeWorkspace.id;

  return {
    ok: true as const,
    workspaces,
    activeWorkspaceId,
    activeWorkspace: activeWorkspace ?? user.workspace,
  };
}

export async function getMe(userId: string, workspaceId: string) {
  await ensureUserMemberships(userId);

  const [user, workspaces] = await Promise.all([
    identityRepo.findUserByIdWithWorkspace(userId),
    listUserWorkspaces(userId),
  ]);

  if (!user) return { ok: false as const, status: 404 as const, error: 'User not found' };

  const activeWorkspace =
    workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? user.workspace;

  const access = await resolveMembershipAccess(userId, activeWorkspace?.id ?? workspaceId);
  const safeUser = sanitizeUser(user);

  return {
    ok: true as const,
    body: {
      ...safeUser,
      role: access.role,
      permissions: access.permissions,
      inboxScope: access.inboxScope,
      workspaces,
      activeWorkspaceId: activeWorkspace?.id ?? workspaceId,
      activeWorkspace,
      ...onboardingPayloadFromUser(user),
    },
  };
}

export async function createWorkspaceForAdmin(userId: string, name: string) {
  const workspace = await identityRepo.createWorkspace({
    name,
    slug: workspaceSlugFromName(name),
    ...newCustomerTrialFields(),
  });

  await identityRepo.createAdminMembership(userId, workspace.id);
  await grantSignupWalletCredit(workspace.id);

  const workspaces = await listUserWorkspaces(userId);
  const user = await identityRepo.findUserById(userId);
  if (!user) return { ok: false as const, status: 404 as const, error: 'User not found' };

  return { ok: true as const, workspace, workspaces, user };
}

export async function loadSwitchWorkspace(userId: string, workspaceId: string) {
  const allowed = await userHasWorkspaceAccess(userId, workspaceId);
  if (!allowed) return { ok: false as const, status: 403 as const, error: 'No access to this company' };

  const user = await identityRepo.findUserById(userId);
  if (!user) return { ok: false as const, status: 404 as const, error: 'User not found' };

  const workspace = await identityRepo.findWorkspaceById(workspaceId);
  if (!workspace) return { ok: false as const, status: 404 as const, error: 'Company not found' };

  const workspaces = await listUserWorkspaces(userId);
  return { ok: true as const, user, workspace, workspaces };
}

export async function getCompany(workspaceId: string) {
  const workspace = await identityRepo.findWorkspaceCompany(workspaceId);
  if (!workspace) return { ok: false as const, status: 404 as const, error: 'Company not found' };

  const whatsappAccounts = await listWhatsAppAccounts(workspaceId);
  const trial = serializeTrialInfo(workspace);

  return {
    ok: true as const,
    body: {
      ...workspace,
      whatsappAccounts,
      connected: whatsappAccounts.length > 0 || !!workspace.waNumberId,
      trial,
    },
  };
}

export async function updateCompany(workspaceId: string, body: Record<string, unknown>) {
  const existing = await identityRepo.findWorkspaceContact(workspaceId);
  if (!existing) return { ok: false as const, status: 404 as const, error: 'Company not found' };

  const data: Record<string, unknown> = { ...body };
  if ('email' in body) {
    const nextEmail = normalizeCompanyEmail(body.email) ?? null;
    const prevEmail = existing.email?.trim().toLowerCase() ?? null;
    if (shouldClearVerifiedAt(prevEmail, nextEmail)) data.emailVerifiedAt = null;
  }
  if ('phone' in body) {
    const nextPhone = normalizeCompanyPhone(body.phone) ?? null;
    const prevPhone = existing.phone?.replace(/\D/g, '') ?? null;
    if (shouldClearVerifiedAt(prevPhone, nextPhone)) data.phoneVerifiedAt = null;
  }

  if (
    ('country' in data && data.country !== undefined) ||
    ('timezone' in data && data.timezone !== undefined)
  ) {
    if (typeof data.timezone === 'string' && !isValidIanaTimeZone(data.timezone)) {
      return { ok: false as const, status: 400 as const, error: 'Invalid IANA timezone' };
    }
    if (typeof data.country === 'string') {
      data.country = data.country.trim().toUpperCase() || null;
    }
  }

  const workspace = await identityRepo.updateWorkspace(
    workspaceId,
    data as Prisma.WorkspaceUpdateInput
  );
  return { ok: true as const, workspace };
}

export async function updateLocale(workspaceId: string, body: { country: string; timezone: string }) {
  return identityRepo.updateWorkspaceLocale(workspaceId, {
    country: body.country,
    timezone: body.timezone,
  });
}

export async function listWorkspacesForUser(userId: string, workspaceId: string) {
  const workspaces = await listUserWorkspaces(userId);
  const active = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
  return { workspaces, activeWorkspaceId: active?.id ?? workspaceId };
}
