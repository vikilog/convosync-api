import type { PrismaClient, WorkspaceAiProviderConfig } from '@prisma/client';
import { config } from '../../../config.js';
import {
  decryptJson,
  encryptJson,
  hasEncryptedPayload,
} from '../../../lib/field-encryption.js';
import {
  AI_PROVIDER_MODELS,
  type AiProviderCredentials,
  normalizeAiProviderMode,
  type AiProviderMode,
  type AiProviderPublicConfig,
  type AiProviderStatus,
  type AiProviderType,
  type ResolvedAiProvider,
} from '../types/ai-provider.types.js';
import { LlmClient, LlmClientError } from './llm-client.service.js';

export type AiProviderDraftInput = {
  mode?: AiProviderMode;
  provider?: AiProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string | null;
};

function validateApiKeyForProvider(provider: AiProviderType, apiKey: string): string | null {
  const key = apiKey.trim();
  if (!key) return 'API key is required.';

  if (provider === 'anthropic') {
    if (!key.startsWith('sk-ant-')) {
      return 'Anthropic keys start with sk-ant-. You may have entered an OpenAI or other provider key.';
    }
    return null;
  }

  if (provider === 'openai') {
    if (key.startsWith('sk-ant-')) {
      return 'This is an Anthropic key. Choose Anthropic as the provider, or use an OpenAI key.';
    }
    if (!key.startsWith('sk-')) {
      return 'OpenAI keys usually start with sk-. Check the key and provider selection.';
    }
    return null;
  }

  return null;
}

function toPublic(row: WorkspaceAiProviderConfig): AiProviderPublicConfig {
  const provider = row.provider as AiProviderType;
  const hasApiKey =
    row.mode === 'byok' ? hasEncryptedPayload(row.encryptedCredentials) : Boolean(config.openai.apiKey);

  return {
    mode: normalizeAiProviderMode(row.mode),
    provider,
    model: row.model,
    baseUrl: row.baseUrl,
    hasApiKey,
    status: row.status as AiProviderStatus,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    availableModels: AI_PROVIDER_MODELS[provider] ?? AI_PROVIDER_MODELS.openai,
  };
}

function defaultRow(workspaceId: string): WorkspaceAiProviderConfig {
  return {
    workspaceId,
    mode: 'convosync',
    provider: 'openai',
    model: config.openai.model,
    encryptedCredentials: null,
    baseUrl: null,
    status: config.openai.apiKey ? 'active' : 'credentials_missing',
    lastTestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export class AiProviderConfigService {
  constructor(private prisma: PrismaClient) {}

  async getOrCreate(workspaceId: string): Promise<WorkspaceAiProviderConfig> {
    const existing = await this.prisma.workspaceAiProviderConfig.findUnique({
      where: { workspaceId },
    });
    if (existing) return existing;

    return this.prisma.workspaceAiProviderConfig.create({
      data: {
        workspaceId,
        mode: 'convosync',
        provider: 'openai',
        model: config.openai.model,
        status: config.openai.apiKey ? 'active' : 'credentials_missing',
      },
    });
  }

  async getPublicConfig(workspaceId: string): Promise<AiProviderPublicConfig> {
    const row = await this.getOrCreate(workspaceId);
    return toPublic(row);
  }

  async resolveForWorkspace(workspaceId: string): Promise<ResolvedAiProvider> {
    return this.resolveForTest(workspaceId);
  }

  async resolveForTest(
    workspaceId: string,
    draft?: AiProviderDraftInput
  ): Promise<ResolvedAiProvider> {
    const row = await this.getOrCreate(workspaceId);
    const mode = normalizeAiProviderMode(draft?.mode ?? row.mode);
    const provider = (draft?.provider ?? row.provider) as AiProviderType;
    const model = draft?.model?.trim() || row.model;

    if (mode === 'convosync') {
      if (!config.openai.apiKey) {
        throw new LlmClientError(
          'ConvoSync AI is not configured. Set OPENAI_API_KEY or switch to Bring Your Own Key.',
          'LLM_NOT_CONFIGURED',
          503
        );
      }
      return {
        mode: 'convosync',
        provider: 'openai',
        model: model || config.openai.model,
        apiKey: config.openai.apiKey,
        baseUrl: null,
        maxOutputTokens: config.ai.maxOutputTokens,
        temperature: config.openai.temperature,
      };
    }

    let apiKey = draft?.apiKey?.trim() || '';
    if (!apiKey && hasEncryptedPayload(row.encryptedCredentials)) {
      const creds = decryptJson<AiProviderCredentials>(row.encryptedCredentials!);
      apiKey = creds.apiKey?.trim() || '';
    }

    if (!apiKey) {
      throw new LlmClientError(
        'Add your API key in Settings → AI Provider to use Bring Your Own Key.',
        'BYOK_CREDENTIALS_MISSING',
        400
      );
    }

    const keyError = validateApiKeyForProvider(provider, apiKey);
    if (keyError) {
      throw new LlmClientError(keyError, 'BYOK_KEY_MISMATCH', 400);
    }

    const baseUrl =
      provider === 'custom'
        ? (draft?.baseUrl !== undefined ? draft.baseUrl?.trim() || null : row.baseUrl?.trim() || null)
        : null;

    return {
      mode: 'byok',
      provider,
      model,
      apiKey,
      baseUrl,
      maxOutputTokens: config.ai.maxOutputTokens,
      temperature: config.openai.temperature,
    };
  }

  isByokMode(workspaceId: string): Promise<boolean> {
    return this.getOrCreate(workspaceId).then((row) => row.mode === 'byok');
  }

  async updateConfig(
    workspaceId: string,
    input: {
      mode?: AiProviderMode;
      provider?: AiProviderType;
      model?: string;
      apiKey?: string;
      baseUrl?: string | null;
    }
  ): Promise<AiProviderPublicConfig> {
    const row = await this.getOrCreate(workspaceId);

    let encryptedCredentials = row.encryptedCredentials;
    if (input.apiKey !== undefined && input.apiKey.trim()) {
      encryptedCredentials = encryptJson({ apiKey: input.apiKey.trim() });
    }

    const mode = input.mode ?? (row.mode as AiProviderMode);
    const provider = input.provider ?? (row.provider as AiProviderType);
    const model = input.model?.trim() || row.model;

    if (mode === 'byok') {
      const keyToValidate =
        input.apiKey?.trim() ||
        (hasEncryptedPayload(encryptedCredentials)
          ? decryptJson<AiProviderCredentials>(encryptedCredentials!).apiKey
          : '');
      if (keyToValidate) {
        const keyError = validateApiKeyForProvider(provider, keyToValidate);
        if (keyError) {
          throw new LlmClientError(keyError, 'BYOK_KEY_MISMATCH', 400);
        }
      }
    }

    let status: AiProviderStatus = 'active';
    if (mode === 'convosync') {
      status = config.openai.apiKey ? 'active' : 'credentials_missing';
    } else if (!hasEncryptedPayload(encryptedCredentials)) {
      status = 'credentials_missing';
    }

    const updated = await this.prisma.workspaceAiProviderConfig.update({
      where: { workspaceId },
      data: {
        mode,
        provider,
        model,
        encryptedCredentials: mode === 'byok' ? encryptedCredentials : null,
        baseUrl:
          provider === 'custom' ? (input.baseUrl?.trim() || row.baseUrl) : null,
        status,
      },
    });

    return toPublic(updated);
  }

  async testConnection(
    workspaceId: string,
    draft?: AiProviderDraftInput
  ): Promise<{ ok: boolean; message: string; provider?: AiProviderType; mode?: AiProviderMode }> {
    try {
      const resolved = await this.resolveForTest(workspaceId, draft);
      const client = new LlmClient(resolved);
      const result = await client.complete(
        [{ role: 'user', content: 'Reply with exactly: OK' }],
        { maxTokens: 16, temperature: 0 }
      );

      if (!draft) {
        await this.prisma.workspaceAiProviderConfig.update({
          where: { workspaceId },
          data: { status: 'active', lastTestedAt: new Date() },
        });
      }

      return {
        ok: true,
        message: result.content.slice(0, 80) || 'Connection successful',
        provider: resolved.provider,
        mode: resolved.mode,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      if (!draft) {
        await this.prisma.workspaceAiProviderConfig.update({
          where: { workspaceId },
          data: { status: 'connection_failed' },
        });
      }
      return { ok: false, message };
    }
  }
}
