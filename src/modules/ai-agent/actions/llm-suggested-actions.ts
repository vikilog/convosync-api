import type { LlmClient } from '../services/llm-client.service.js';
import type { AgentAction } from './action-executor.js';

const LLM_ELIGIBLE_ACTION_TYPES = ['add_contact_tags', 'update_contact_attributes'] as const;
type LlmEligibleActionType = (typeof LLM_ELIGIBLE_ACTION_TYPES)[number];

/**
 * Strict JSON Schema for OpenAI Structured Outputs.
 * Attributes are key/value pairs (free-form Record is not allowed under strict).
 */
export const suggestedActionsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: [...LLM_ELIGIBLE_ACTION_TYPES] },
          config: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tags: { type: 'array', items: { type: 'string' } },
              attributes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    key: { type: 'string' },
                    value: { type: 'string' },
                  },
                  required: ['key', 'value'],
                },
              },
            },
            required: ['tags', 'attributes'],
          },
        },
        required: ['type', 'config'],
      },
    },
  },
  required: ['actions'],
} as const;

export const SUGGESTED_ACTIONS_SYSTEM_HINT = `Also optionally suggest contact tags or attribute updates when clearly warranted (e.g. customer mentioned their name, clear interest/complaint).
Do not suggest escalation or closing.
For update_contact_attributes use config.attributes as [{key,value},...].
For add_contact_tags use config.tags (and attributes: []).
Always include both tags and attributes on each action config (use [] when unused).
If nothing is warranted, return actions: [].`;

/** Combined reply + actions schema for a single compose LLM call (LangGraph). */
export const composeWithActionsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    actions: suggestedActionsSchema.properties.actions,
  },
  required: ['reply', 'actions'],
} as const;

type LlmSuggestedRaw = {
  actions?: Array<{
    type?: string;
    config?: {
      tags?: unknown;
      attributes?: unknown;
    };
  }>;
};

function isEligibleType(type: string): type is LlmEligibleActionType {
  return (LLM_ELIGIBLE_ACTION_TYPES as readonly string[]).includes(type);
}

function attributesFromConfig(raw: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!Array.isArray(raw)) return attributes;
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const key = (row as { key?: unknown }).key;
    const value = (row as { value?: unknown }).value;
    if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) {
      attributes[key] = value;
    }
  }
  return attributes;
}

export function normalizeSuggestedActions(raw: LlmSuggestedRaw): AgentAction[] {
  const out: AgentAction[] = [];
  for (const item of raw.actions ?? []) {
    if (!item?.type || !isEligibleType(item.type)) continue;
    if (item.type === 'add_contact_tags') {
      const tags = Array.isArray(item.config?.tags)
        ? item.config.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : [];
      if (tags.length) out.push({ type: 'add_contact_tags', config: { tags } });
      continue;
    }
    if (item.type === 'update_contact_attributes') {
      const attributes = attributesFromConfig(item.config?.attributes);
      if (Object.keys(attributes).length) {
        out.push({ type: 'update_contact_attributes', config: { attributes } });
      }
    }
  }
  return out;
}

export async function getLlmSuggestedActions(params: {
  message: string;
  reply: string;
  llmClient: LlmClient;
  workspaceId?: string;
}): Promise<AgentAction[]> {
  const { content } = await params.llmClient.completeJsonSchema(
    [
      {
        role: 'system',
        content: `You may suggest contact tags or attribute updates based on this exchange.
Only suggest if clearly warranted (e.g. customer mentioned their name, a clear interest/complaint category).
Do not suggest escalation or closing — those are handled separately.
For update_contact_attributes, put fields in config.attributes as [{key,value},...].
For add_contact_tags, put strings in config.tags (and set attributes to []).
Always include both tags and attributes arrays on config (use [] when unused).
Return {"actions":[]} when nothing is warranted.`,
      },
      {
        role: 'user',
        content: `Customer: ${params.message}\nAgent reply: ${params.reply}`,
      },
    ],
    suggestedActionsSchema as unknown as Record<string, unknown>,
    {
      name: 'suggested_actions',
      maxTokens: 200,
      temperature: 0,
      workspaceId: params.workspaceId,
    }
  );

  let parsed: LlmSuggestedRaw;
  try {
    parsed = JSON.parse(content) as LlmSuggestedRaw;
  } catch {
    return [];
  }
  return normalizeSuggestedActions(parsed);
}
