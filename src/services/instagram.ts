import axios from 'axios';
import {
  INSTAGRAM_USER_PROFILE_FIELDS,
  type InstagramUserProfile,
} from '../lib/instagramProfile.js';

export type SendInstagramResult = {
  messageId: string;
};

type MetaGraphError = {
  error?: {
    message?: string;
    error_user_msg?: string;
    code?: number;
    error_subcode?: number;
  };
};

function metaGraphError(err: unknown): MetaGraphError['error'] | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  return (err.response?.data as MetaGraphError | undefined)?.error;
}

/** Meta (#10 / 2534022): free-form RESPONSE only within 24h of last customer message. */
export function isInstagramOutsideMessagingWindow(err: unknown): boolean {
  const graphErr = metaGraphError(err);
  if (!graphErr) return false;
  if (graphErr.error_subcode === 2534022) return true;
  const msg = (graphErr.message || graphErr.error_user_msg || '').toLowerCase();
  // Messenger: "outside the allowed window"; Instagram often: "outside of allowed window"
  if (msg.includes('outside') && msg.includes('allowed window')) return true;
  return graphErr.code === 10 && msg.includes('messaging window');
}

export function formatInstagramSendError(err: unknown): string {
  if (isInstagramOutsideMessagingWindow(err)) {
    return (
      'Meta blocked this Instagram reply (outside messaging window / #2534022). ' +
      'Live mode alone is not enough: (1) Instagram Messaging + HUMAN_AGENT need Advanced Access ' +
      '(not only permission granted); (2) recipient must message @ your connected IG account; ' +
      '(3) synced inbox history does not open the Send API window — wait for a live webhook DM, ' +
      'then reply within 24 hours. Check server logs for [Instagram Webhook] POST hit.'
    );
  }
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as MetaGraphError;
    const msg = data?.error?.error_user_msg || data?.error?.message;
    if (msg) return msg;
    if (err.response?.status === 401) {
      return 'Instagram access token expired or invalid. Reconnect in Integrations.';
    }
  }
  if (err instanceof Error) return err.message;
  return 'Failed to send Instagram message';
}

/** Messenger Platform sender_action — works for Instagram Messaging too. */
export async function sendInstagramTypingOn(
  pageId: string,
  pageAccessToken: string,
  recipientInstagramScopedId: string
): Promise<void> {
  await axios.post(
    `https://graph.facebook.com/v25.0/${pageId}/messages`,
    {
      recipient: { id: recipientInstagramScopedId },
      sender_action: 'typing_on',
    },
    { params: { access_token: pageAccessToken } }
  );
}

async function postInstagramMessage(
  actorId: string,
  pageAccessToken: string,
  payload: Record<string, unknown>
): Promise<SendInstagramResult> {
  const res = await axios.post(`https://graph.facebook.com/v25.0/${actorId}/messages`, payload, {
    params: { access_token: pageAccessToken },
  });

  const messageId = (res.data as { message_id?: string }).message_id;
  if (!messageId) {
    throw new Error('Meta API did not return a message id');
  }

  return { messageId };
}

type SendInstagramOptions = {
  /** Last customer message mid — helps Meta associate the reply */
  replyToMid?: string;
  /** IG professional account id — tried if Page-id send fails */
  instagramUserId?: string;
  /** Instagram Messaging quick_replies (max 13, title ≤20 chars) */
  quickReplies?: Array<{ title: string; payload?: string }>;
};

/**
 * Send text DM. Tries RESPONSE (24h), then HUMAN_AGENT (7d, needs Advanced Access).
 */
export async function sendInstagramMessage(
  pageId: string,
  pageAccessToken: string,
  recipientInstagramScopedId: string,
  text: string,
  options?: SendInstagramOptions
): Promise<SendInstagramResult> {
  const body = text.trim();
  if (!body) {
    throw new Error('Message cannot be empty');
  }

  const quickReplies = (options?.quickReplies ?? [])
    .map((q) => ({
      content_type: 'text' as const,
      title: q.title.trim().slice(0, 20),
      payload: (q.payload?.trim() || q.title.trim()).slice(0, 1000),
    }))
    .filter((q) => q.title.length > 0)
    .slice(0, 13);

  const message: Record<string, unknown> = { text: body.slice(0, 1000) };
  if (quickReplies.length) {
    message.quick_replies = quickReplies;
  }
  const recipient = { id: recipientInstagramScopedId };
  const replyTo = options?.replyToMid
    ? { reply_to: { mid: options.replyToMid } }
    : {};

  const actors = [pageId, 'me', options?.instagramUserId].filter(
    (id, i, arr): id is string => Boolean(id) && arr.indexOf(id) === i
  );

  let lastErr: unknown;
  for (const actor of actors) {
    try {
      return await postInstagramMessage(actor, pageAccessToken, {
        recipient,
        messaging_type: 'RESPONSE',
        message,
        ...replyTo,
      });
    } catch (err) {
      lastErr = err;
      if (!isInstagramOutsideMessagingWindow(err)) throw err;
    }
  }

  // ponytail: HUMAN_AGENT needs Advanced Access; still try after RESPONSE window errors
  try {
    return await postInstagramMessage(pageId, pageAccessToken, {
      recipient,
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
      message,
      ...replyTo,
    });
  } catch (err) {
    // Prefer HUMAN_AGENT error when it differs (e.g. tag not approved vs window)
    throw err ?? lastErr;
  }
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
  // ponytail: never seed name with IGSID — that blocked @username fallback forever
  let profile: InstagramUserProfile = {};

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
