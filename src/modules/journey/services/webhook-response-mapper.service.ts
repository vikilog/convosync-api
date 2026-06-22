import type { WebhookResponseMapping } from '../types/journey.types.js';
import { mergeContactCustomFields } from './journey-contact-actions.service.js';
import { getByJsonPath, valueToStoredString } from './json-path.service.js';

export type AppliedWebhookMapping = {
  attributeKey: string;
  jsonPath: string;
  value: string;
};

export async function applyWebhookResponseMappings(
  contactId: string,
  responseBody: unknown,
  mappings: WebhookResponseMapping[] | undefined
): Promise<AppliedWebhookMapping[]> {
  if (!mappings?.length) return [];

  const toSave: Record<string, string> = {};
  const applied: AppliedWebhookMapping[] = [];

  for (const mapping of mappings) {
    const jsonPath = mapping.jsonPath?.trim();
    const attributeKey = mapping.attributeKey?.trim();
    if (!jsonPath || !attributeKey) continue;

    const extracted = getByJsonPath(responseBody, jsonPath);
    if (extracted === undefined) continue;

    const value = valueToStoredString(extracted);
    toSave[attributeKey] = value;
    applied.push({ attributeKey, jsonPath, value });
  }

  if (Object.keys(toSave).length > 0) {
    await mergeContactCustomFields(contactId, toSave);
  }

  return applied;
}
