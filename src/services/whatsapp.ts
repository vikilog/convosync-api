import axios from 'axios';
import { normalizeWhatsAppRecipient } from '../lib/phone.js';
import { normalizeMetaLanguageCode } from './metaMessageTemplates.js';

export type SendWhatsAppResult = {
  waMessageId: string;
  waId?: string;
};

/** HTTP 429 (or Meta's app-level throttling codes) — the number is being rate-limited. */
export function isMetaRateLimitError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (err.response?.status === 429) return true;
  const code = (err.response?.data as { error?: { code?: number } } | undefined)?.error?.code;
  // 4 = app rate limit, 80007 = WhatsApp Business API rate limit, 130429 = message throughput limit.
  return code === 4 || code === 80007 || code === 130429;
}

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
    /** Per-recipient token for a template with a FLOW button — required on every send. */
    flowToken?: string;
    headerMedia?: {
      format: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
      waMediaId: string;
      fileName?: string;
    };
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
      parameters: Array<Record<string, unknown>>;
    }>;
  } = {
    name: templateName,
    language: { code: normalizeMetaLanguageCode(languageCode) },
  };

  const components: NonNullable<(typeof template)['components']> = [];

  if (options?.headerMedia) {
    const mediaType = options.headerMedia.format.toLowerCase();
    const mediaPayload: Record<string, unknown> = { id: options.headerMedia.waMediaId };
    if (mediaType === 'document' && options.headerMedia.fileName?.trim()) {
      mediaPayload.filename = options.headerMedia.fileName.trim();
    }
    components.push({
      type: 'header',
      parameters: [{ type: mediaType, [mediaType]: mediaPayload }],
    });
  }

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

  if (options?.flowToken?.trim()) {
    components.push({
      type: 'button',
      sub_type: 'flow',
      index: '0',
      parameters: [{ type: 'action', action: { flow_token: options.flowToken.trim() } }],
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

/** Reply buttons (max 3). Button id is returned as interactive.button_reply.id. */
export async function sendWhatsAppReplyButtons(
  waToken: string,
  phoneNumberId: string,
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
): Promise<SendWhatsAppResult> {
  const recipient = normalizeWhatsAppRecipient(to);
  const body = bodyText.trim();
  if (!body) throw new Error('Message cannot be empty');
  const btns = buttons
    .map((b) => ({
      type: 'reply' as const,
      reply: {
        id: String(b.id).trim().slice(0, 256),
        title: String(b.title).trim().slice(0, 20),
      },
    }))
    .filter((b) => b.reply.id && b.reply.title)
    .slice(0, 3);
  if (btns.length < 1) throw new Error('At least one button is required');

  const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const res = await axios.post(
    apiUrl,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: { buttons: btns },
      },
    },
    { headers: { Authorization: `Bearer ${waToken}` } }
  );

  const data = res.data as {
    messages?: Array<{ id: string }>;
    contacts?: Array<{ wa_id: string }>;
  };
  const waMessageId = data.messages?.[0]?.id;
  if (!waMessageId) throw new Error('Meta API did not return a message id');
  return { waMessageId, waId: data.contacts?.[0]?.wa_id };
}

/**
 * Typing indicator — requires an inbound WhatsApp message id.
 * Auto-dismisses on send or after ~25s.
 */
export async function sendWhatsAppTypingIndicator(
  waToken: string,
  phoneNumberId: string,
  inboundMessageId: string
): Promise<void> {
  const mid = inboundMessageId.trim();
  if (!mid) return;
  const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  await axios.post(
    apiUrl,
    {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: mid,
      typing_indicator: { type: 'text' },
    },
    { headers: { Authorization: `Bearer ${waToken}` } }
  );
}

/** Navigate-only WhatsApp Flow send — no data-exchange endpoint, Meta calls back once on submit. */
export async function sendWhatsAppFlowMessage(
  waToken: string,
  phoneNumberId: string,
  to: string,
  params: {
    bodyText: string;
    metaFlowId: string;
    flowToken: string;
    ctaLabel: string;
    firstScreenId: string;
    headerText?: string;
    footerText?: string;
  }
): Promise<SendWhatsAppResult> {
  const recipient = normalizeWhatsAppRecipient(to);
  const body = params.bodyText.trim();
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
        type: 'flow',
        ...(params.headerText ? { header: { type: 'text', text: params.headerText } } : {}),
        body: { text: body },
        ...(params.footerText ? { footer: { text: params.footerText } } : {}),
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: params.flowToken,
            flow_id: params.metaFlowId,
            flow_cta: params.ctaLabel.slice(0, 30),
            flow_action: 'navigate',
            // Meta rejects an empty `data: {}` object ("must be of type dynamic_object") —
            // omit the key entirely when there's nothing to prefill on the first screen.
            flow_action_payload: { screen: params.firstScreenId },
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
