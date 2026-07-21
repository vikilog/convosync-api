import { config } from '../config.js';
import { prisma } from '../index.js';
import { decryptSecret, isSecretStored } from '../lib/field-encryption.js';
import { ensureWhatsAppAccountsMigrated } from './whatsappAccounts.js';

export type WorkspaceWhatsAppCredentials = {
  wabaId: string;
  accessToken: string;
  phoneNumberId?: string;
  /** True when SUPER_ADMIN_ACCESS_TOKEN from .env was used */
  usedEnvAdminToken?: boolean;
};

/**
 * Resolve WhatsApp Graph credentials for a workspace.
 * Super-admin workspace: prefer long-lived SUPER_ADMIN_* from .env (same token as Graph Explorer).
 * Other tenants: encrypted workspace.waToken from Embedded Signup.
 */
export async function getWorkspaceWhatsAppCredentials(
  workspaceId: string,
  phoneNumberId?: string | null
): Promise<WorkspaceWhatsAppCredentials> {
  await ensureWhatsAppAccountsMigrated(workspaceId);

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      isSuperAdmin: true,
      waToken: true,
      wabaId: true,
      waNumberId: true,
    },
  });
  const fallbackAccount = await prisma.whatsAppPhoneAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  let wabaId = workspace?.wabaId || fallbackAccount?.wabaId || undefined;
  let resolvedPhoneNumberId =
    phoneNumberId || workspace?.waNumberId || fallbackAccount?.phoneNumberId || undefined;
  let accessToken = decryptSecret(workspace?.waToken);
  let usedEnvAdminToken = false;

  if (phoneNumberId) {
    const account = await prisma.whatsAppPhoneAccount.findFirst({
      where: { workspaceId, phoneNumberId },
    });
    if (!account) {
      throw new Error('WhatsApp number is not connected for this company.');
    }
    wabaId = account.wabaId || wabaId;
    resolvedPhoneNumberId = account.phoneNumberId;
  }

  // Platform owner: .env long-lived system/user token (Graph Explorer parity)
  if (workspace?.isSuperAdmin) {
    const envToken = config.superAdmin.whatsappAccessToken;
    if (envToken) {
      accessToken = envToken;
      usedEnvAdminToken = true;
    }
    if (config.superAdmin.wabaId) {
      wabaId = wabaId || config.superAdmin.wabaId;
    }
    if (!resolvedPhoneNumberId && config.superAdmin.phoneNumberId) {
      resolvedPhoneNumberId = config.superAdmin.phoneNumberId;
    }
  }

  if (!accessToken || !wabaId) {
    throw new Error(
      workspace?.isSuperAdmin && !config.superAdmin.whatsappAccessToken
        ? 'Super-admin WhatsApp token missing. Set SUPER_ADMIN_ACCESS_TOKEN in backend/.env.'
        : 'WhatsApp is not connected for this company. Connect a number in WhatsApp Manager first.'
    );
  }

  // Non-super-admin still requires a stored DB token (encrypted or legacy plaintext)
  if (!workspace?.isSuperAdmin && !isSecretStored(workspace?.waToken)) {
    throw new Error(
      'WhatsApp is not connected for this company. Connect a number in WhatsApp Manager first.'
    );
  }

  return {
    wabaId,
    accessToken,
    phoneNumberId: resolvedPhoneNumberId,
    usedEnvAdminToken,
  };
}
