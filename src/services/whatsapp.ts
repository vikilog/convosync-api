import axios from 'axios';
import { normalizeWhatsAppRecipient } from '../lib/phone.js';
import { normalizeMetaLanguageCode } from './metaMessageTemplates.js';

export type SendWhatsAppResult = {
  waMessageId: string;
  waId?: string;
};

export function formatMetaSendError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as {
      error?: { message?: string; error_user_msg?: string; code?: number };
    };
    const msg = data?.error?.error_user_msg || data?.error?.message;
    if (msg) return msg;
    if (err.response?.status === 401) return 'WhatsApp access token expired or invalid. Reconnect in WhatsApp Manager.';
  }
  if (err instanceof Error) return err.message;
  return 'Failed to send WhatsApp message';
}

export async function sendWhatsAppMessage(
  waToken: string,
  phoneNumberId: string,
  to: string,
  text: string
): Promise<SendWhatsAppResult> {
  const recipient = normalizeWhatsAppRecipient(to);
  const body = text.trim();
  if (!body) {
    throw new Error('Message cannot be empty');
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const res = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { body },
    },
    { headers: { Authorization: `Bearer ${waToken}` } }
  );

  const data = res.data as {
    messages?: Array<{ id: string }>;
    contacts?: Array<{ wa_id: string }>;
  };

  const waMessageId = data.messages?.[0]?.id;
  if (!waMessageId) {
    throw new Error('Meta API did not return a message id');
  }

  return {
    waMessageId,
    waId: data.contacts?.[0]?.wa_id,
  };
}

export async function sendWhatsAppTemplateMessage(
  waToken: string,
  phoneNumberId: string,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParameters: string[],
  options?: {
    buttonUrlParameter?: string;
  }
): Promise<SendWhatsAppResult> {
  const recipient = normalizeWhatsAppRecipient(to);

  const template: {
    name: string;
    language: { code: string };
    components?: Array<{
      type: string;
      sub_type?: string;
      index?: string;
      parameters: Array<{ type: string; text: string }>;
    }>;
  } = {
    name: templateName,
    language: { code: normalizeMetaLanguageCode(languageCode) },
  };

  const components: NonNullable<(typeof template)['components']> = [];

  if (bodyParameters.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyParameters.map((text) => ({ type: 'text', text: text.trim() })),
    });
  }

  if (options?.buttonUrlParameter?.trim()) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: options.buttonUrlParameter.trim() }],
    });
  }

  if (components.length > 0) {
    template.components = components;
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const res = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template,
    },
    { headers: { Authorization: `Bearer ${waToken}` } }
  );

  const data = res.data as {
    messages?: Array<{ id: string }>;
    contacts?: Array<{ wa_id: string }>;
  };

  const waMessageId = data.messages?.[0]?.id;
  if (!waMessageId) {
    throw new Error('Meta API did not return a message id');
  }

  return {
    waMessageId,
    waId: data.contacts?.[0]?.wa_id,
  };
}

function renderTemplateBody(bodyPattern: string, values: string[]): string {
  return bodyPattern.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    const value = values[idx]?.trim();
    return value || `{{${n}}}`;
  });
}

export { renderTemplateBody };

export async function sendWhatsAppCtaUrlMessage(
  waToken: string,
  phoneNumberId: string,
  to: string,
  bodyText: string,
  buttonLabel: string,
  url: string
): Promise<SendWhatsAppResult> {
  const recipient = normalizeWhatsAppRecipient(to);
  const body = bodyText.trim();
  if (!body) {
    throw new Error('Message cannot be empty');
  }

  const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const res = await axios.post(
    apiUrl,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: body },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: buttonLabel.slice(0, 20),
            url,
          },
        },
      },
    },
    { headers: { Authorization: `Bearer ${waToken}` } }
  );

  const data = res.data as {
    messages?: Array<{ id: string }>;
    contacts?: Array<{ wa_id: string }>;
  };

  const waMessageId = data.messages?.[0]?.id;
  if (!waMessageId) {
    throw new Error('Meta API did not return a message id');
  }

  return {
    waMessageId,
    waId: data.contacts?.[0]?.wa_id,
  };
}
