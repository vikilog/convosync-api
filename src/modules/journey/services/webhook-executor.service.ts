import axios from 'axios';
import type { WebhookNodeData } from '../types/journey.types.js';
import { renderTemplateVariables } from './message-renderer.service.js';
import type { Contact } from '@prisma/client';

export type WebhookExecutionResult = {
  statusCode: number;
  body: unknown;
  attempts: number;
};

function renderBody(
  body: WebhookNodeData['body'],
  contact: Contact
): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    return renderTemplateVariables(body, contact);
  }
  const rendered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    rendered[key] =
      typeof value === 'string' ? renderTemplateVariables(value, contact) : value;
  }
  return JSON.stringify(rendered);
}

function renderHeaders(
  headers: Record<string, string> | undefined,
  contact: Contact
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = renderTemplateVariables(value, contact);
  }
  return out;
}

export async function executeWebhookNode(
  config: WebhookNodeData,
  contact: Contact
): Promise<WebhookExecutionResult> {
  const retries = Math.max(0, config.retries ?? 2);
  const timeoutMs = config.timeoutMs ?? 15_000;
  const method = config.method ?? 'POST';
  const url = renderTemplateVariables(config.url, contact);
  const headers = renderHeaders(config.headers, contact);
  const body = method === 'POST' ? renderBody(config.body, contact) : undefined;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await axios.request({
        method,
        url,
        headers,
        data: body,
        timeout: timeoutMs,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) {
        return { statusCode: res.status, body: res.data, attempts: attempt + 1 };
      }
      lastError = new Error(`Webhook returned HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Webhook request failed');
}
