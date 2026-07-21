import axios from 'axios';
import { prisma } from '../index.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';

/** Match Graph API Explorer default (user confirmed profile works there). */
const GRAPH = 'https://graph.facebook.com/v22.0';
const PROFILE_FIELDS = 'about,address,description,email,profile_picture_url,websites,vertical';

export const WHATSAPP_PROFILE_VERTICALS = [
  'OTHER',
  'AUTO',
  'BEAUTY',
  'APPAREL',
  'EDU',
  'ENTERTAIN',
  'EVENT_PLAN',
  'FINANCE',
  'GROCERY',
  'GOVT',
  'HOTEL',
  'HEALTH',
  'NONPROFIT',
  'PROF_SERVICES',
  'RETAIL',
  'TRAVEL',
  'RESTAURANT',
  'ALCOHOL',
  'ONLINE_GAMBLING',
  'PHYSICAL_GAMBLING',
  'OTC_DRUGS',
] as const;

export type WhatsAppProfileVertical = (typeof WHATSAPP_PROFILE_VERTICALS)[number];

export type WhatsAppBusinessProfile = {
  about: string;
  address: string;
  description: string;
  email: string;
  websites: string[];
  vertical: string;
  profilePictureUrl: string | null;
  messagingProduct?: string;
};

export type WhatsAppPhoneProfileMeta = {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  nameStatus: string | null;
};

export type WhatsAppBusinessProfileBundle = WhatsAppPhoneProfileMeta & {
  profile: WhatsAppBusinessProfile;
};

export type WhatsAppBusinessProfileUpdate = {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  vertical?: string;
};

function metaErrorMessage(err: unknown): string {
  const ax = err as {
    response?: {
      data?: {
        error?: {
          message?: string;
          error_user_msg?: string;
          code?: number;
        };
      };
    };
    message?: string;
  };
  const meta = ax.response?.data?.error;
  return (
    meta?.error_user_msg ||
    meta?.message ||
    ax.message ||
    'Meta WhatsApp profile request failed'
  );
}

function normalizeWebsites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean)
    .slice(0, 2);
}

/**
 * Same shape as Graph API Explorer:
 * GET /{phone-number-id}/whatsapp_business_profile?fields=...&access_token=...
 * (Explorer appends the user token as query — Bearer-only also works, but query matches Explorer.)
 */
async function graphGetBusinessProfile(phoneNumberId: string, accessToken: string) {
  const res = await axios.get(`${GRAPH}/${phoneNumberId}/whatsapp_business_profile`, {
    params: {
      fields: PROFILE_FIELDS,
      access_token: accessToken,
    },
    // Do not also send Authorization — dual auth has caused Meta to reject valid tokens
  });
  return (res.data?.data?.[0] || {}) as Record<string, unknown>;
}

async function graphGetPhoneMeta(phoneNumberId: string, accessToken: string) {
  try {
    const res = await axios.get(`${GRAPH}/${phoneNumberId}`, {
      params: {
        fields: 'display_phone_number,verified_name,quality_rating,name_status',
        access_token: accessToken,
      },
    });
    return (res.data || {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function getWhatsAppBusinessProfile(
  workspaceId: string,
  phoneNumberId: string
): Promise<WhatsAppBusinessProfileBundle> {
  const account = await prisma.whatsAppPhoneAccount.findFirst({
    where: { workspaceId, phoneNumberId },
  });
  if (!account) {
    throw new Error('WhatsApp number is not connected for this company.');
  }

  const { accessToken } = await getWorkspaceWhatsAppCredentials(workspaceId, phoneNumberId);
  if (!accessToken) {
    throw new Error('WhatsApp access token missing. Reconnect WhatsApp.');
  }

  try {
    // Call profile first — same endpoint that works in Graph Explorer
    const row = await graphGetBusinessProfile(phoneNumberId, accessToken);
    const phone = await graphGetPhoneMeta(phoneNumberId, accessToken);

    return {
      phoneNumberId,
      displayPhoneNumber:
        typeof phone.display_phone_number === 'string'
          ? phone.display_phone_number
          : account.phoneNumber,
      verifiedName:
        typeof phone.verified_name === 'string' ? phone.verified_name : account.displayName,
      qualityRating: typeof phone.quality_rating === 'string' ? phone.quality_rating : null,
      nameStatus: typeof phone.name_status === 'string' ? phone.name_status : null,
      profile: {
        about: typeof row.about === 'string' ? row.about : '',
        address: typeof row.address === 'string' ? row.address : '',
        description: typeof row.description === 'string' ? row.description : '',
        email: typeof row.email === 'string' ? row.email : '',
        websites: normalizeWebsites(row.websites),
        vertical: typeof row.vertical === 'string' ? row.vertical : '',
        profilePictureUrl:
          typeof row.profile_picture_url === 'string' ? row.profile_picture_url : null,
        messagingProduct:
          typeof row.messaging_product === 'string' ? row.messaging_product : 'whatsapp',
      },
    };
  } catch (err) {
    const raw = metaErrorMessage(err);
    // Explorer often uses a different user token than Embedded Signup storage
    if (/does not exist|missing permissions|unsupported get request/i.test(raw)) {
      throw new Error(
        `${raw} — Graph Explorer uses your Facebook login token; ConvoSync uses the token saved at WhatsApp connect. ` +
          `If Explorer works but the app fails, disconnect and reconnect WhatsApp in Integrations so a fresh token is stored.`
      );
    }
    throw new Error(raw);
  }
}

export async function updateWhatsAppBusinessProfile(
  workspaceId: string,
  phoneNumberId: string,
  input: WhatsAppBusinessProfileUpdate
): Promise<{ success: true }> {
  const account = await prisma.whatsAppPhoneAccount.findFirst({
    where: { workspaceId, phoneNumberId },
  });
  if (!account) {
    throw new Error('WhatsApp number is not connected for this company.');
  }

  const { accessToken } = await getWorkspaceWhatsAppCredentials(workspaceId, phoneNumberId);
  if (!accessToken) {
    throw new Error('WhatsApp access token missing. Reconnect WhatsApp.');
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
  };

  if (input.about !== undefined) {
    const about = input.about.trim();
    if (!about || about.length > 139) {
      throw new Error('About must be between 1 and 139 characters');
    }
    body.about = about;
  }
  if (input.address !== undefined) {
    const address = input.address.trim();
    if (address.length > 256) throw new Error('Address must be 256 characters or fewer');
    body.address = address;
  }
  if (input.description !== undefined) {
    const description = input.description.trim();
    if (description.length > 512) throw new Error('Description must be 512 characters or fewer');
    body.description = description;
  }
  if (input.email !== undefined) {
    const email = input.email.trim();
    if (email.length > 128) throw new Error('Email must be 128 characters or fewer');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid email address');
    }
    body.email = email;
  }
  if (input.websites !== undefined) {
    const websites = normalizeWebsites(input.websites);
    for (const url of websites) {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('Websites must start with http:// or https://');
      }
      if (url.length > 256) throw new Error('Each website URL must be 256 characters or fewer');
    }
    body.websites = websites;
  }
  if (input.vertical !== undefined) {
    const vertical = input.vertical.trim().toUpperCase();
    if (
      vertical &&
      !WHATSAPP_PROFILE_VERTICALS.includes(vertical as WhatsAppProfileVertical)
    ) {
      throw new Error('Invalid business category');
    }
    body.vertical = vertical;
  }

  try {
    await axios.post(`${GRAPH}/${phoneNumberId}/whatsapp_business_profile`, body, {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
    });
    return { success: true };
  } catch (err) {
    throw new Error(metaErrorMessage(err));
  }
}
