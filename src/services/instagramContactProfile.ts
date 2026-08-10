import { prisma } from '../index.js';
import {
  instagramProfileToCustomFields,
  isInstagramPlaceholderContactName,
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

  const shouldReplaceName =
    isInstagramPlaceholderContactName(contact.name, senderId) ||
    contact.name === contact.phone;

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      name: shouldReplaceName ? contactName : contact.name,
      avatar: contact.avatar || profile.profile_pic || undefined,
      customFields,
    },
  });
}

/** When Graph is skipped (fresh cache) but name is still a placeholder, heal from username. */
async function healPlaceholderFromCachedUsername(
  contact: ContactRow,
  senderId: string,
  existing: Record<string, string>,
  fallbackName?: string
): Promise<void> {
  if (!isInstagramPlaceholderContactName(contact.name, senderId)) return;
  const username = existing.instagramUsername?.trim();
  if (!username && !fallbackName?.trim()) return;
  await applyInstagramProfileToContact(
    contact,
    username ? { username } : {},
    senderId,
    fallbackName
  );
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
    // Cache fresh — still overwrite Instagram ##### from cached @username (no Graph).
    await healPlaceholderFromCachedUsername(
      params.contact,
      params.senderId,
      existing,
      params.fallbackName
    );
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
