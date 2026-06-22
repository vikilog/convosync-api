import { prisma } from '../index.js';
import {
  instagramProfileToCustomFields,
  resolveInstagramContactName,
  shouldRefreshInstagramProfile,
  type InstagramUserProfile,
} from '../lib/instagramProfile.js';
import { fetchInstagramUserProfile } from './instagram.js';

type ContactRow = {
  id: string;
  name: string;
  phone: string;
  avatar: string | null;
  customFields: unknown;
};

export async function applyInstagramProfileToContact(
  contact: ContactRow,
  profile: InstagramUserProfile,
  senderId: string,
  fallbackName?: string
) {
  const existing = (contact.customFields as Record<string, string> | null) || {};
  const contactName = resolveInstagramContactName(profile, senderId, fallbackName);
  const customFields = instagramProfileToCustomFields(profile, existing);

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      name: contact.name === contact.phone ? contactName : contact.name,
      avatar: contact.avatar || profile.profile_pic || undefined,
      customFields,
    },
  });
}

export async function refreshInstagramContactProfile(params: {
  contact: ContactRow;
  senderId: string;
  pageAccessToken: string;
  businessInstagramUserId?: string;
  fallbackName?: string;
  force?: boolean;
}): Promise<InstagramUserProfile | null> {
  const existing = (params.contact.customFields as Record<string, string> | null) || {};
  if (!params.force && !shouldRefreshInstagramProfile(existing)) {
    return null;
  }

  const profile = await fetchInstagramUserProfile(params.senderId, params.pageAccessToken, {
    businessInstagramUserId: params.businessInstagramUserId,
    username: existing.instagramUsername || undefined,
  });

  await applyInstagramProfileToContact(
    params.contact,
    profile,
    params.senderId,
    params.fallbackName
  );

  return profile;
}
