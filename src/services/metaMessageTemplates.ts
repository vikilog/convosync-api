import axios from 'axios';
import {
  metaCategoryToSystem,
  metaStatusToSystem,
  systemCategoryToMeta,
} from '../constants/templateLabels.js';
import type { WorkspaceWhatsAppCredentials } from './whatsappCredentials.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export type MetaTemplateComponent = {
  type: string;
  text?: string;
  format?: string;
  buttons?: Array<{
    type: string;
    text: string;
    url?: string;
    phone_number?: string;
    /** Meta returns this as a JSON number on GET, despite sending it as a string on POST. */
    flow_id?: string | number;
    flow_action?: string;
    navigate_screen?: string;
  }>;
  example?: {
    body_text?: string[][];
    header_text?: string[];
    header_handle?: string[];
  };
};

export type MetaTemplateRecord = {
  id?: string;
  name: string;
  status: string;
  category: string;
  language: string;
  components?: MetaTemplateComponent[];
  rejected_reason?: string;
};

export function sanitizeTemplateName(raw: string): string {
  const trimmed = raw.trim();
  if (/https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed) || /\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
    throw new Error('Template name cannot be a URL — use letters, numbers, and underscores only');
  }
  const name = trimmed
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!name) throw new Error('Template name must contain letters or numbers');
  if (name.includes('http') || name.includes('www')) {
    throw new Error('Template name cannot be a URL — use letters, numbers, and underscores only');
  }
  return name.slice(0, 512);
}

export function extractVariableIndexes(body: string): number[] {
  const found = new Set<number>();
  for (const match of body.matchAll(/\{\{(\d+)\}\}/g)) {
    found.add(parseInt(match[1], 10));
  }
  return [...found].sort((a, b) => a - b);
}

export function buildVariableSamples(body: string, samples?: string[]): string[] {
  const indexes = extractVariableIndexes(body);
  if (indexes.length === 0) return [];
  // Meta requires consecutive {{1}}..{{n}} with no gaps
  for (let i = 0; i < indexes.length; i++) {
    if (indexes[i] !== i + 1) {
      throw new Error(
        `Variables must be consecutive starting at {{1}}. Found {{${indexes[i]}}} but expected {{${i + 1}}}.`
      );
    }
  }
  const row: string[] = [];
  for (let i = 1; i <= indexes.length; i++) {
    const sample = samples?.[i - 1]?.trim() || `sample_${i}`;
    row.push(sample);
  }
  return row;
}

/**
 * Normalize Meta template language for Graph API.
 * Keep exact locale codes (`en` vs `en_US` are different templates) — never coerce between them.
 * Only map common human labels Meta UI may show.
 */
export function normalizeMetaLanguageCode(language: string): string {
  const code = language.trim();
  if (!code) return code;
  const key = code.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (key === 'english us' || key === 'english (us)') return 'en_US';
  if (key === 'english uk' || key === 'english (uk)') return 'en_GB';
  if (key === 'english') return 'en';
  return code;
}

function bodyTextFromComponents(components: MetaTemplateComponent[]): string {
  for (const c of components) {
    if ((c.type || '').toUpperCase() === 'BODY') return c.text || '';
  }
  return '';
}

/** Meta rejects variables at the very start or end of body text. */
export function validateBodyForMeta(body: string): void {
  const trimmed = body.trim();
  if (/^\{\{\d+\}\}/.test(trimmed)) {
    throw new Error('Body cannot start with a variable. Add text before {{1}}.');
  }
  if (/\{\{\d+\}\}\s*$/.test(trimmed)) {
    throw new Error('Body cannot end with a variable. Add text after the last variable.');
  }
}

export function parseMetaComponents(components: MetaTemplateComponent[] | undefined) {
  let bodyPattern = '';
  let header: string | null = null;
  let headerFormat: string | null = null;
  let footer: string | null = null;
  const buttons: string[] = [];
  let buttonType: string | null = null;
  let buttonText: string | null = null;
  let buttonUrl: string | null = null;
  let buttonPhoneNumber: string | null = null;
  let buttonFlowMetaId: string | null = null;

  for (const c of components || []) {
    if (c.type === 'BODY' && c.text) bodyPattern = c.text;
    if (c.type === 'HEADER') {
      headerFormat = c.format || (c.text ? 'TEXT' : null);
      if (c.text) header = c.text;
    }
    if (c.type === 'FOOTER' && c.text) footer = c.text;
    if (c.type === 'BUTTONS' && c.buttons?.[0]) {
      const b = c.buttons[0];
      buttonType = b.type;
      buttonText = b.text;
      buttonUrl = b.url ?? null;
      buttonPhoneNumber = b.phone_number ?? null;
      buttonFlowMetaId = b.flow_id != null ? String(b.flow_id) : null;
      buttons.push(b.text);
    }
  }

  const indexes = extractVariableIndexes(bodyPattern);
  const variables = indexes.map((i) => `param_${i}`);

  return {
    bodyPattern,
    header,
    headerFormat,
    footer,
    buttons,
    buttonType,
    buttonText,
    buttonUrl,
    buttonPhoneNumber,
    buttonFlowMetaId,
    variables,
  };
}

export function buildMetaComponents(input: {
  bodyPattern: string;
  header?: string | null;
  headerFormat?: string | null;
  headerMediaHandle?: string | null;
  footer?: string | null;
  buttonType?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  buttonPhoneNumber?: string | null;
  buttonUrlSample?: string | null;
  /** FLOW button only — Meta's flow id (not ConvoSync's WhatsAppFlow.id) and its first screen. */
  buttonFlowMetaId?: string | null;
  buttonFlowFirstScreenId?: string | null;
  variableSamples?: string[];
}): MetaTemplateComponent[] {
  const components: MetaTemplateComponent[] = [];

  const format = (input.headerFormat || 'TEXT').toUpperCase();
  if (format === 'TEXT' && input.header?.trim()) {
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: input.header.trim(),
    });
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
    const handle = input.headerMediaHandle?.trim();
    if (!handle) {
      throw new Error(`Upload a sample ${format.toLowerCase()} for the media header.`);
    }
    components.push({
      type: 'HEADER',
      format,
      example: { header_handle: [handle] },
    });
  }

  const body = input.bodyPattern.trim();
  validateBodyForMeta(body);
  const samples = buildVariableSamples(body, input.variableSamples);
  const bodyComponent: MetaTemplateComponent = { type: 'BODY', text: body };
  if (samples.length > 0) {
    bodyComponent.example = { body_text: [samples] };
  }
  components.push(bodyComponent);

  if (input.footer?.trim()) {
    components.push({ type: 'FOOTER', text: input.footer.trim() });
  }

  if (input.buttonText?.trim() && input.buttonType) {
    const rawType = input.buttonType.toUpperCase();
    const btnType =
      rawType === 'URL'
        ? 'URL'
        : rawType === 'PHONE_NUMBER'
          ? 'PHONE_NUMBER'
          : rawType === 'FLOW'
            ? 'FLOW'
            : 'QUICK_REPLY';
    const btn: {
      type: string;
      text: string;
      url?: string;
      phone_number?: string;
      flow_id?: string;
      flow_action?: string;
      navigate_screen?: string;
      example?: string[];
    } = {
      type: btnType,
      text: input.buttonText.trim(),
    };
    if (btnType === 'URL') {
      const url = input.buttonUrl?.trim();
      if (!url) throw new Error('Website URL is required for URL buttons.');
      btn.url = url;
      if (/\{\{\d+\}\}/.test(url)) {
        const sample = input.buttonUrlSample?.trim() || 'sample_link_id';
        btn.example = [sample];
      } else {
        btn.example = [url];
      }
    }
    if (btnType === 'PHONE_NUMBER') {
      const phone = input.buttonPhoneNumber?.trim();
      if (!phone) throw new Error('Phone number is required for call buttons.');
      btn.phone_number = phone;
    }
    if (btnType === 'FLOW') {
      const flowMetaId = input.buttonFlowMetaId?.trim();
      const firstScreenId = input.buttonFlowFirstScreenId?.trim();
      if (!flowMetaId || !firstScreenId) {
        throw new Error('Select a published flow for the Flow button.');
      }
      btn.flow_id = flowMetaId;
      btn.flow_action = 'navigate';
      btn.navigate_screen = firstScreenId;
    }
    components.push({ type: 'BUTTONS', buttons: [btn] });
  }

  return components;
}

function mapMetaStatus(status: string): string {
  return metaStatusToSystem(status);
}

function mapCategoryToMeta(category: string): string {
  return systemCategoryToMeta(metaCategoryToSystem(category));
}

function mapCategoryFromMeta(category: string): string {
  return metaCategoryToSystem(category);
}

export async function fetchMetaMessageTemplates(
  creds: WorkspaceWhatsAppCredentials
): Promise<MetaTemplateRecord[]> {
  const res = await axios.get(`${GRAPH}/${creds.wabaId}/message_templates`, {
    params: {
      access_token: creds.accessToken,
      limit: 250,
      fields: 'id,name,status,category,language,components,rejected_reason',
    },
  });
  return (res.data?.data ?? []) as MetaTemplateRecord[];
}

export async function createMetaMessageTemplate(
  creds: WorkspaceWhatsAppCredentials,
  input: {
    name: string;
    category: string;
    language: string;
    components: MetaTemplateComponent[];
  }
) {
  const language = normalizeMetaLanguageCode(input.language);
  const bodyText = bodyTextFromComponents(input.components);
  const hasPositionalVars = extractVariableIndexes(bodyText).length > 0;

  const payload: Record<string, unknown> = {
    name: input.name,
    category: mapCategoryToMeta(input.category),
    language,
    components: input.components,
  };

  if (hasPositionalVars) {
    payload.parameter_format = 'positional';
  }

  try {
    const res = await axios.post(`${GRAPH}/${creds.wabaId}/message_templates`, payload, {
      params: { access_token: creds.accessToken },
    });
    return res.data as { id?: string; status?: string; category?: string };
  } catch (firstErr) {
    // Older WABAs may reject parameter_format; retry without it
    if (hasPositionalVars && payload.parameter_format) {
      const { parameter_format: _pf, ...legacyPayload } = payload;
      try {
        const res = await axios.post(
          `${GRAPH}/${creds.wabaId}/message_templates`,
          legacyPayload,
          { params: { access_token: creds.accessToken } }
        );
        return res.data as { id?: string; status?: string; category?: string };
      } catch {
        throw firstErr;
      }
    }
    throw firstErr;
  }
}

export type MetaTemplateAnalyticsClick = {
  type: string;
  button_content?: string;
  count: number;
};

export type MetaTemplateAnalyticsCost = {
  type: string;
  value: number;
};

export type MetaTemplateAnalyticsDataPoint = {
  template_id: string;
  start: number;
  end: number;
  sent?: number;
  delivered?: number;
  read?: number;
  clicked?: MetaTemplateAnalyticsClick[];
  cost?: MetaTemplateAnalyticsCost[];
};

/**
 * Meta caps template_analytics at 10 template_ids per call and only
 * supports DAILY granularity — see
 * https://developers.facebook.com/docs/whatsapp/business-management-api/analytics/
 */
export async function fetchMetaTemplateAnalytics(
  creds: WorkspaceWhatsAppCredentials,
  input: { templateIds: string[]; start: number; end: number }
): Promise<MetaTemplateAnalyticsDataPoint[]> {
  const res = await axios.get(`${GRAPH}/${creds.wabaId}/template_analytics`, {
    params: {
      access_token: creds.accessToken,
      start: input.start,
      end: input.end,
      granularity: 'DAILY',
      template_ids: JSON.stringify(input.templateIds.slice(0, 10)),
      metric_types: JSON.stringify(['SENT', 'DELIVERED', 'READ', 'CLICKED']),
    },
  });
  const entries = (res.data?.data ?? []) as Array<{
    data_points?: MetaTemplateAnalyticsDataPoint[];
  }>;
  return entries.flatMap((e) => e.data_points ?? []);
}

export async function deleteMetaMessageTemplate(
  creds: WorkspaceWhatsAppCredentials,
  templateName: string
) {
  await axios.delete(`${GRAPH}/${creds.wabaId}/message_templates`, {
    params: {
      access_token: creds.accessToken,
      name: templateName,
    },
  });
}

type MetaApiError = {
  message?: string;
  error_user_msg?: string;
  error_user_title?: string;
  error_subcode?: number;
  error_data?: string;
};

export function metaErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { error?: MetaApiError } } })?.response?.data
    ?.error;
  if (data) {
    const detail = data.error_user_msg || data.message || 'Meta API request failed';
    const title = data.error_user_title;
    const sub = data.error_subcode != null ? ` (code ${data.error_subcode})` : '';
    return title ? `${title}: ${detail}${sub}` : `${detail}${sub}`;
  }
  return err instanceof Error ? err.message : 'Meta API request failed';
}

export { mapMetaStatus, mapCategoryFromMeta, mapCategoryToMeta };
