import axios from 'axios';
import { config } from '../config.js';

const GRAPH_VERSION = 'v21.0';

export type WebhookSubscribeResult = {
  wabaSubscribed: boolean;
  overrideApplied: boolean;
  appFieldsConfigured: boolean;
  error?: string;
  details?: string;
};

function formatMetaApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as {
      error?: { message?: string; error_user_msg?: string; code?: number };
    };
    return data?.error?.error_user_msg || data?.error?.message || err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Meta API request failed';
}

function isAlreadySubscribedError(err: unknown): boolean {
  const msg = formatMetaApiError(err).toLowerCase();
  return (
    msg.includes('already') ||
    msg.includes('duplicate') ||
    msg.includes('subscribed')
  );
}

/** App access token: APP_ID|APP_SECRET */
function appAccessToken(): string {
  return `${config.meta.appId}|${config.meta.appSecret}`;
}

/**
 * Register app webhook fields on the Meta app (messages, template status).
 * WhatsApp message delivery for a WABA still requires subscribed_apps on the WABA.
 */
async function configureAppWebhookFields(options?: { coexistence?: boolean }): Promise<void> {
  if (!config.meta.appId || !config.meta.appSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET are required');
  }

  const baseFields = ['messages', 'message_template_status_update'];
  const coexistenceFields = ['history', 'smb_app_state_sync', 'smb_message_echoes'];
  const fields = options?.coexistence
    ? [...baseFields, ...coexistenceFields].join(',')
    : baseFields.join(',');

  await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${config.meta.appId}/subscriptions`,
    null,
    {
      params: {
        object: 'whatsapp_business_account',
        callback_url: config.webhookUrl,
        verify_token: config.meta.webhookVerifyToken,
        fields,
        access_token: appAccessToken(),
      },
    }
  );
}

/**
 * Subscribe this app to a WABA and point webhooks at our callback URL.
 * Meta sends GET hub.challenge to verify — BACKEND_PUBLIC_URL must be reachable.
 */
async function subscribeWabaWithOverride(
  wabaId: string,
  accessToken: string
): Promise<{ success: boolean; usedOverride: boolean }> {
  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`,
    {
      override_callback_uri: config.webhookUrl,
      verify_token: config.meta.webhookVerifyToken,
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return {
    success: res.data?.success === true,
    usedOverride: true,
  };
}

/** Basic subscribe when app-level callback is already set in Meta Dashboard. */
async function subscribeWabaBasic(wabaId: string, accessToken: string): Promise<boolean> {
  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.data?.success === true;
}

export type WebhookSubscriptionStatus = {
  subscribed: boolean;
  overrideCallbackUri?: string;
  apps: Array<{ id?: string; name?: string }>;
};

/** Read current WABA webhook subscriptions (for status UI). */
export async function getWebhookSubscriptionStatus(
  wabaId: string,
  accessToken: string
): Promise<WebhookSubscriptionStatus> {
  const res = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/subscribed_apps`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const data = (res.data?.data || []) as Array<{
    whatsapp_business_api_data?: { id?: string; name?: string };
    override_callback_uri?: string;
  }>;

  const ours = data.find(
    (row) =>
      row.whatsapp_business_api_data?.id === config.meta.appId ||
      row.override_callback_uri === config.webhookUrl
  );

  return {
    subscribed: data.length > 0,
    overrideCallbackUri: ours?.override_callback_uri || data[0]?.override_callback_uri,
    apps: data.map((row) => ({
      id: row.whatsapp_business_api_data?.id,
      name: row.whatsapp_business_api_data?.name,
    })),
  };
}

/**
 * Subscribe webhooks after WhatsApp connect.
 * Does not throw — returns result so connect can succeed even if verify fails (e.g. local dev).
 */
export async function subscribeWhatsAppWebhooks(
  wabaId: string,
  accessToken: string,
  options?: { coexistence?: boolean }
): Promise<WebhookSubscribeResult> {
  const result: WebhookSubscribeResult = {
    wabaSubscribed: false,
    overrideApplied: false,
    appFieldsConfigured: false,
  };

  if (!wabaId) {
    result.error = 'Missing WhatsApp Business Account id';
    return result;
  }

  if (!config.webhookUrl?.startsWith('https://')) {
    result.error =
      'BACKEND_PUBLIC_URL must be a public HTTPS URL so Meta can verify the webhook (e.g. dev tunnel).';
    return result;
  }

  try {
    const sub = await subscribeWabaWithOverride(wabaId, accessToken);
    result.wabaSubscribed = sub.success;
    result.overrideApplied = sub.usedOverride && sub.success;
  } catch (err) {
    if (isAlreadySubscribedError(err)) {
      result.wabaSubscribed = true;
      result.overrideApplied = true;
      result.details = 'WABA already subscribed';
    } else {
      try {
        result.wabaSubscribed = await subscribeWabaBasic(wabaId, accessToken);
        result.details =
          'Subscribed without URL override. Set callback in Meta App Dashboard or fix BACKEND_PUBLIC_URL.';
        if (!result.wabaSubscribed) {
          result.error = formatMetaApiError(err);
        }
      } catch (basicErr) {
        result.error = formatMetaApiError(err) || formatMetaApiError(basicErr);
        return result;
      }
    }
  }

  try {
    await configureAppWebhookFields(options);
    result.appFieldsConfigured = true;
  } catch (err) {
    if (isAlreadySubscribedError(err)) {
      result.appFieldsConfigured = true;
    } else {
      const fieldErr = formatMetaApiError(err);
      result.details = [result.details, `App fields: ${fieldErr}`].filter(Boolean).join('; ');
    }
  }

  return result;
}
