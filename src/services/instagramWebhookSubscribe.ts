import axios from 'axios';

export type InstagramWebhookSubscribeResult = {
  subscribed: boolean;
  error?: string;
  details?: string;
  messagingSubscribed?: boolean;
  commentsSubscribed?: boolean;
};

/** Page fields needed for Instagram + Messenger DMs (incl. handover standby). */
const PAGE_MESSAGING_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_echoes',
  'messaging_referrals',
  'messaging_seen',
  'message_reads',
  'standby',
].join(',');

/** Instagram object fields for live Social Listening comments (App Dashboard must also subscribe these). */
const IG_COMMENT_WEBHOOK_FIELDS = ['comments', 'live_comments'].join(',');

/** Facebook Page object field for live Social Listening comments (feed carries post/comment/reaction events). */
const FEED_COMMENT_WEBHOOK_FIELDS = 'feed';

function graphErrMessage(err: unknown): string {
  return (
    (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
      ?.message || (err as Error)?.message || 'unknown error'
  );
}

export async function subscribePageMessaging(
  pageId: string,
  pageAccessToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${pageId}/subscribed_apps`, null, {
      params: {
        subscribed_fields: PAGE_MESSAGING_WEBHOOK_FIELDS,
        access_token: pageAccessToken,
      },
    });
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: graphErrMessage(err) };
  }
}

/** Subscribe IG professional account to comment webhooks (Facebook Login + Page token). */
async function subscribeIgComments(
  instagramUserId: string,
  pageAccessToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${instagramUserId}/subscribed_apps`,
      null,
      {
        params: {
          subscribed_fields: IG_COMMENT_WEBHOOK_FIELDS,
          access_token: pageAccessToken,
        },
      }
    );
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: graphErrMessage(err) };
  }
}

/** Subscribe a Facebook Page to `feed` comment webhooks (Social Listening). */
export async function subscribeFacebookPageFeed(
  pageId: string,
  pageAccessToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${pageId}/subscribed_apps`, null, {
      params: {
        subscribed_fields: FEED_COMMENT_WEBHOOK_FIELDS,
        access_token: pageAccessToken,
      },
    });
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: graphErrMessage(err) };
  }
}

export async function subscribeInstagramPageWebhooks(
  pageId: string,
  pageAccessToken: string,
  instagramUserId?: string | null
): Promise<InstagramWebhookSubscribeResult> {
  const messaging = await subscribePageMessaging(pageId, pageAccessToken);
  const comments = instagramUserId
    ? await subscribeIgComments(instagramUserId, pageAccessToken)
    : { ok: false, error: 'Missing Instagram user id' };

  if (messaging.ok && comments.ok) {
    return {
      subscribed: true,
      messagingSubscribed: true,
      commentsSubscribed: true,
    };
  }

  // Messaging alone still useful for DMs; comments alone useful for listening
  if (messaging.ok || comments.ok) {
    return {
      subscribed: true,
      messagingSubscribed: messaging.ok,
      commentsSubscribed: comments.ok,
      error: !comments.ok
        ? 'Comment webhook subscription failed (check App Dashboard Instagram → comments + Advanced Access)'
        : 'Messaging webhook subscription failed',
      details: [messaging.error, comments.error].filter(Boolean).join(' | '),
    };
  }

  return {
    subscribed: false,
    messagingSubscribed: false,
    commentsSubscribed: false,
    error: 'Instagram webhook subscription failed',
    details: [messaging.error, comments.error].filter(Boolean).join(' | '),
  };
}

/** Take thread control so future DMs arrive on `messaging` instead of `standby`. */
export async function takeInstagramThreadControl(
  pageId: string,
  pageAccessToken: string,
  recipientId: string
): Promise<void> {
  await axios.post(
    `https://graph.facebook.com/v25.0/${pageId}/take_thread_control`,
    {
      recipient: { id: recipientId },
      metadata: 'ConvoSync inbox claimed thread',
    },
    { params: { access_token: pageAccessToken } }
  );
}
