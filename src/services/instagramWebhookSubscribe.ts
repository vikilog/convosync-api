import axios from 'axios';

export type InstagramWebhookSubscribeResult = {
  subscribed: boolean;
  error?: string;
  details?: string;
};

export async function subscribeInstagramPageWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<InstagramWebhookSubscribeResult> {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`, null, {
      params: {
        subscribed_fields: 'messages,messaging_postbacks,message_echoes',
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
