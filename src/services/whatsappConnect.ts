import axios from 'axios';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { encryptSecret } from '../lib/field-encryption.js';
import {
  subscribeWhatsAppWebhooks,
  type WebhookSubscribeResult,
} from './whatsappWebhookSubscribe.js';
import {
  triggerCoexistenceDataSync,
  type CoexistenceSyncResult,
} from './whatsappCoexistenceSync.js';
import { assertChannelCreateAllowed } from './planUsageGuards.js';

export type WhatsAppConnectionMode = 'business_api' | 'app_coexistence';

export type WhatsAppConnectInput = {
  workspaceId: string;
  code: string;
  redirectUri?: string;
  wabaId?: string;
  phoneNumberId?: string;
  phoneNumber?: string;
  displayName?: string;
  connectionMode?: WhatsAppConnectionMode;
};

export type WhatsAppConnectResult = {
  phoneNumber: string;
  phoneNumberId: string;
  wabaId: string;
  displayName?: string;
  connectionMode?: WhatsAppConnectionMode;
  webhookSubscribe?: WebhookSubscribeResult;
  coexistenceSync?: CoexistenceSyncResult;
};

function uniqueRedirectCandidates(preferred?: string): Array<string | undefined> {
  const base = config.frontendUrl.replace(/\/$/, '');
  const withUri = [
    preferred,
    config.meta.embeddedRedirectUri,
    config.meta.oauthRedirectUri,
    `${base}/integrations`,
    `${base}/manager`,
    base,
    `${base}/whatsapp/callback`,
  ].filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);

  // Popup Embedded Signup often binds code without redirect_uri — try that first.
  const ordered: Array<string | undefined> = [undefined, ...withUri];
  const seen = new Set<string>();
  return ordered.filter((uri) => {
    const key = uri ?? '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function exchangeCodeForToken(
  code: string,
  redirectUri?: string
): Promise<string> {
  const params: Record<string, string> = {
    client_id: config.meta.appId,
    client_secret: config.meta.appSecret,
    code,
  };
  if (redirectUri) {
    params.redirect_uri = redirectUri;
  }

  const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
    params,
  });

  const accessToken = tokenRes.data.access_token;
  if (!accessToken) {
    throw new Error('Failed to get access token from Meta');
  }
  return accessToken;
}

function isRedirectUriError(err: unknown): boolean {
  const message =
    (err as any)?.response?.data?.error?.message ||
    (err as any)?.message ||
    '';
  return String(message).toLowerCase().includes('redirect_uri');
}

function isCodeInvalidError(err: unknown): boolean {
  const message =
    (err as any)?.response?.data?.error?.message ||
    (err as any)?.message ||
    '';
  const lower = String(message).toLowerCase();
  return (
    lower.includes('code') &&
    (lower.includes('expired') || lower.includes('invalid') || lower.includes('used'))
  );
}

export async function connectWorkspaceWhatsApp(
  input: WhatsAppConnectInput
): Promise<WhatsAppConnectResult> {
  const redirectCandidates = uniqueRedirectCandidates(input.redirectUri);
  let accessToken: string | undefined;
  let lastError: unknown;

  for (const redirectUri of redirectCandidates) {
    try {
      accessToken = await exchangeCodeForToken(input.code, redirectUri);
      break;
    } catch (err) {
      lastError = err;
      if (isCodeInvalidError(err)) throw err;
      if (!isRedirectUriError(err)) throw err;
    }
  }

  if (!accessToken) {
    throw lastError || new Error('Failed to exchange Meta authorization code');
  }

  let wabaId = input.wabaId;
  let phoneNumberId = input.phoneNumberId;
  let phoneNumber = input.phoneNumber;
  let displayName = input.displayName;

  if (!wabaId) {
    const debugRes = await axios.get('https://graph.facebook.com/v19.0/debug_token', {
      params: {
        input_token: accessToken,
        access_token: `${config.meta.appId}|${config.meta.appSecret}`,
      },
    });

    const granularScopes = debugRes.data?.data?.granular_scopes || [];
    const wabaScope = granularScopes.find(
      (scope: { scope?: string }) => scope.scope === 'whatsapp_business_management'
    );
    wabaId = wabaScope?.target_ids?.[0];
  }

  if (!wabaId) {
    throw new Error('No WhatsApp Business Account found');
  }

  if (!phoneNumberId) {
    const phoneRes = await axios.get(`https://graph.facebook.com/v19.0/${wabaId}/phone_numbers`, {
      params: { fields: 'id,display_phone_number,verified_name' },
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const phones = phoneRes.data?.data || [];
    if (phones.length === 0) {
      throw new Error('No phone numbers found in this WhatsApp Business Account');
    }

    phoneNumberId = phones[0].id;
    phoneNumber = phones[0].display_phone_number;
    displayName = phones[0].verified_name;
  } else if (!phoneNumber) {
    const phoneRes = await axios.get(`https://graph.facebook.com/v19.0/${phoneNumberId}`, {
      params: { fields: 'display_phone_number,verified_name' },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    phoneNumber = phoneRes.data?.display_phone_number;
    displayName = displayName || phoneRes.data?.verified_name;
  }

  const isCoexistence = input.connectionMode === 'app_coexistence';

  if (!isCoexistence) {
    await axios
      .post(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/register`,
        {
          messaging_product: 'whatsapp',
          pin: '000000',
        },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      .catch(() => {
        // Already registered
      });
  }

  // One Meta number → one active workspace inbox (latest connect wins).
  await prisma.whatsAppPhoneAccount.deleteMany({
    where: {
      phoneNumberId: phoneNumberId!,
      workspaceId: { not: input.workspaceId },
    },
  });

  const existingInWorkspace = await prisma.whatsAppPhoneAccount.findUnique({
    where: {
      workspaceId_phoneNumberId: {
        workspaceId: input.workspaceId,
        phoneNumberId: phoneNumberId!,
      },
    },
    select: { id: true },
  });
  if (!existingInWorkspace) {
    await assertChannelCreateAllowed(input.workspaceId);
  }

  await prisma.whatsAppPhoneAccount.upsert({
    where: {
      workspaceId_phoneNumberId: {
        workspaceId: input.workspaceId,
        phoneNumberId: phoneNumberId!,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      phoneNumberId: phoneNumberId!,
      wabaId,
      phoneNumber,
      displayName,
    },
    update: {
      wabaId,
      phoneNumber,
      displayName,
    },
  });

  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: {
      waNumberId: phoneNumberId,
      waToken: encryptSecret(accessToken),
      wabaId,
      waPhoneNumber: phoneNumber,
    },
  });

  const webhookSubscribe = await subscribeWhatsAppWebhooks(wabaId, accessToken, {
    coexistence: isCoexistence,
  });

  let coexistenceSync: CoexistenceSyncResult | undefined;
  if (isCoexistence) {
    coexistenceSync = await triggerCoexistenceDataSync(phoneNumberId!, accessToken);
  }

  return {
    phoneNumber: phoneNumber || phoneNumberId!,
    phoneNumberId: phoneNumberId!,
    wabaId,
    displayName,
    connectionMode: input.connectionMode,
    webhookSubscribe,
    coexistenceSync,
  };
}
