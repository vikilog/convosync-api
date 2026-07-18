import axios, { AxiosError } from 'axios';
import OpenAI from 'openai';
import { config } from '../../../config.js';
import type { ResolvedAiProvider } from '../types/ai-provider.types.js';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmCompletionUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export class LlmClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

export class LlmClient {
  constructor(private readonly resolved: ResolvedAiProvider) {}

  get mode() {
    return this.resolved.mode;
  }

  get model() {
    return this.resolved.model;
  }

  async complete(
    messages: LlmMessage[],
    options?: { maxTokens?: number; temperature?: number; jsonMode?: boolean }
  ): Promise<{ content: string; usage: LlmCompletionUsage }> {
    const maxTokens = options?.maxTokens ?? this.resolved.maxOutputTokens;
    const temperature = options?.temperature ?? this.resolved.temperature;

    if (this.resolved.provider === 'anthropic') {
      return this.completeAnthropic(messages, maxTokens, temperature);
    }

    return this.completeOpenAiCompatible(messages, maxTokens, temperature, options?.jsonMode);
  }

  /**
   * OpenAI Structured Outputs (`json_schema` + strict). Not supported on Anthropic.
   * Reuses the same client timeout as `complete` (`config.openai.timeoutMs`).
   */
  async completeJsonSchema(
    messages: LlmMessage[],
    jsonSchema: Record<string, unknown>,
    options?: { name?: string; maxTokens?: number; temperature?: number }
  ): Promise<{ content: string; usage: LlmCompletionUsage }> {
    if (this.resolved.provider === 'anthropic') {
      throw new LlmClientError(
        'Structured Outputs (json_schema) require OpenAI or an OpenAI-compatible provider.',
        'LLM_STRUCTURED_UNSUPPORTED',
        400
      );
    }

    const maxTokens = options?.maxTokens ?? this.resolved.maxOutputTokens;
    const temperature = options?.temperature ?? this.resolved.temperature;
    const schemaName = options?.name || 'response';

    const baseURL = this.resolved.baseUrl?.replace(/\/$/, '') || undefined;
    const client = new OpenAI({
      apiKey: this.resolved.apiKey,
      baseURL: baseURL ? `${baseURL}/v1` : undefined,
      timeout: config.openai.timeoutMs,
    });

    try {
      const response = await client.chat.completions.create({
        model: this.resolved.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaName,
            strict: true,
            schema: jsonSchema,
          },
        },
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new LlmClientError('Empty response from AI provider', 'LLM_EMPTY_RESPONSE', 502);
      }

      const usage = response.usage;
      return {
        content,
        usage: {
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
        },
      };
    } catch (err) {
      throw mapClientError(err);
    }
  }

  private async completeOpenAiCompatible(
    messages: LlmMessage[],
    maxTokens: number,
    temperature: number,
    jsonMode?: boolean
  ): Promise<{ content: string; usage: LlmCompletionUsage }> {
    const baseURL = this.resolved.baseUrl?.replace(/\/$/, '') || undefined;
    const client = new OpenAI({
      apiKey: this.resolved.apiKey,
      baseURL: baseURL ? `${baseURL}/v1` : undefined,
      timeout: config.openai.timeoutMs,
    });

    try {
      const response = await client.chat.completions.create({
        model: this.resolved.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new LlmClientError('Empty response from AI provider', 'LLM_EMPTY_RESPONSE', 502);
      }

      const usage = response.usage;
      return {
        content,
        usage: {
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
        },
      };
    } catch (err) {
      throw mapClientError(err);
    }
  }

  private async completeAnthropic(
    messages: LlmMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<{ content: string; usage: LlmCompletionUsage }> {
    const system = messages.find((m) => m.role === 'system')?.content;
    const chatMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    try {
      const res = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: this.resolved.model,
          max_tokens: maxTokens,
          temperature,
          system: system || undefined,
          messages: chatMessages,
        },
        {
          headers: {
            'x-api-key': this.resolved.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          timeout: config.openai.timeoutMs,
        }
      );

      const blocks = res.data?.content as Array<{ type: string; text?: string }> | undefined;
      const content = blocks?.find((b) => b.type === 'text')?.text?.trim();
      if (!content) {
        throw new LlmClientError('Empty response from Anthropic', 'LLM_EMPTY_RESPONSE', 502);
      }

      const usage = res.data?.usage ?? {};
      const promptTokens = Number(usage.input_tokens ?? 0);
      const completionTokens = Number(usage.output_tokens ?? 0);

      return {
        content,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    } catch (err) {
      throw mapAxiosError(err);
    }
  }
}

function mapClientError(err: unknown): LlmClientError {
  if (err instanceof LlmClientError) return err;
  if (err instanceof OpenAI.APIError) {
    return new LlmClientError(
      err.message || 'AI provider request failed',
      'LLM_REQUEST_FAILED',
      err.status ?? 502
    );
  }
  const message = err instanceof Error ? err.message : 'Unknown AI provider error';
  return new LlmClientError(message, 'LLM_REQUEST_FAILED', 502);
}

function mapAxiosError(err: unknown): LlmClientError {
  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 502;
    const apiMessage =
      (err.response?.data as { error?: { message?: string } })?.error?.message ??
      err.message;
    return new LlmClientError(
      `AI provider request failed: ${apiMessage}`,
      'LLM_REQUEST_FAILED',
      status >= 400 && status < 600 ? status : 502
    );
  }
  return mapClientError(err);
}
