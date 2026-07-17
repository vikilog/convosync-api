import axios from 'axios';

export type InstagramWebhookSubscribeResult = {
  subscribed: boolean;
  error?: string;
  details?: string;
};

/** Page fields needed for Instagram + Messenger DMs (incl. handover standby). */
const PAGE_MESSAGING_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_echoes',
  'messaging_referrals',
  'standby',
].join(',');

export async function subscribeInstagramPageWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<InstagramWebhookSubscribeResult> {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${pageId}/subscribed_apps`, null, {
      params: {
        subscribed_fields: PAGE_MESSAGING_WEBHOOK_FIELDS,
        access_token: pageAccessToken,
      },
    });
    return { subscribed: true };
  } catch (err: unknown) {
    const message =
      (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message || (err as Error)?.message;
    return {
      subscribed: false,
      error: 'Instagram webhook subscription failed',
      details: message,
    };
  }
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
