import axios from 'axios';
import {
  INSTAGRAM_USER_PROFILE_FIELDS,
  type InstagramUserProfile,
} from '../lib/instagramProfile.js';

export type SendInstagramResult = {
  messageId: string;
};

export function formatInstagramSendError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as {
      error?: { message?: string; error_user_msg?: string };
    };
    const msg = data?.error?.error_user_msg || data?.error?.message;
    if (msg) return msg;
    if (err.response?.status === 401) {
      return 'Instagram access token expired or invalid. Reconnect in Integrations.';
    }
  }
  if (err instanceof Error) return err.message;
  return 'Failed to send Instagram message';
}

export async function sendInstagramMessage(
  pageId: string,
  pageAccessToken: string,
  recipientInstagramScopedId: string,
  text: string
): Promise<SendInstagramResult> {
  const body = text.trim();
  if (!body) {
    throw new Error('Message cannot be empty');
  }

  const res = await axios.post(
    `https://graph.facebook.com/v25.0/${pageId}/messages`,
    {
      recipient: { id: recipientInstagramScopedId },
      messaging_type: 'RESPONSE',
      message: { text: body.slice(0, 1000) },
    },
    { params: { access_token: pageAccessToken } }
  );

  const messageId = (res.data as { message_id?: string }).message_id;
  if (!messageId) {
    throw new Error('Meta API did not return a message id');
  }

  return { messageId };
}

async function fetchInstagramBusinessDiscovery(
  businessInstagramUserId: string,
  username: string,
  pageAccessToken: string
): Promise<Pick<InstagramUserProfile, 'biography' | 'follower_count' | 'follows_count' | 'media_count'>> {
  try {
    const fields = `business_discovery.username(${username}){biography,followers_count,follows_count,media_count,username}`;
    const res = await axios.get(`https://graph.facebook.com/v25.0/${businessInstagramUserId}`, {
      params: {
        fields,
        access_token: pageAccessToken,
      },
    });
    const discovery = (res.data as { business_discovery?: Record<string, unknown> })
      .business_discovery;
    if (!discovery) return {};

    return {
      biography: typeof discovery.biography === 'string' ? discovery.biography : undefined,
      follower_count:
        typeof discovery.followers_count === 'number' ? discovery.followers_count : undefined,
      follows_count:
        typeof discovery.follows_count === 'number' ? discovery.follows_count : undefined,
      media_count: typeof discovery.media_count === 'number' ? discovery.media_count : undefined,
    };
  } catch {
    return {};
  }
}

export async function fetchInstagramUserProfile(
  instagramScopedUserId: string,
  pageAccessToken: string,
  options?: { businessInstagramUserId?: string; username?: string }
): Promise<InstagramUserProfile> {
  let profile: InstagramUserProfile = { name: instagramScopedUserId };

  try {
    const res = await axios.get(`https://graph.facebook.com/v25.0/${instagramScopedUserId}`, {
      params: {
        fields: INSTAGRAM_USER_PROFILE_FIELDS,
        access_token: pageAccessToken,
      },
    });
    profile = { ...profile, ...(res.data as InstagramUserProfile) };
  } catch {
    return profile;
  }

  const username = options?.username || profile.username;
  if (username && options?.businessInstagramUserId) {
    const discovery = await fetchInstagramBusinessDiscovery(
      options.businessInstagramUserId,
      username.replace(/^@/, ''),
      pageAccessToken
    );
    profile = {
      ...profile,
      biography: discovery.biography || profile.biography,
      follower_count: profile.follower_count ?? discovery.follower_count,
      follows_count: discovery.follows_count ?? profile.follows_count,
      media_count: discovery.media_count ?? profile.media_count,
    };
  }

  return profile;
}
