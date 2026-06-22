export type AiProviderMode = 'convosync' | 'byok';

/** Legacy workspaces may still have `wabiz` stored in the database. */
export function normalizeAiProviderMode(mode: string): AiProviderMode {
  if (mode === 'byok') return 'byok';
  return 'convosync';
}

export type AiProviderType = 'openai' | 'anthropic' | 'custom';

export type AiProviderStatus = 'active' | 'credentials_missing' | 'connection_failed';

export interface AiProviderCredentials extends Record<string, unknown> {
  apiKey: string;
}

export interface AiProviderPublicConfig {
  mode: AiProviderMode;
  provider: AiProviderType;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  status: AiProviderStatus;
  lastTestedAt: string | null;
  availableModels: string[];
}

export interface ResolvedAiProvider {
  mode: AiProviderMode;
  provider: AiProviderType;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  maxOutputTokens: number;
  temperature: number;
}

export const AI_PROVIDER_MODELS: Record<AiProviderType, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: [
    'claude-3-5-haiku-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-opus-latest',
  ],
  custom: ['llama3.2', 'mistral', 'qwen2.5', 'gpt-4o-mini'],
};

export const AI_PROVIDER_LABELS: Record<AiProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  custom: 'Custom (OpenAI-compatible)',
};
