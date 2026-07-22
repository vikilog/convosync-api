import axios, { AxiosError } from 'axios';
import OpenAI from 'openai';
import { SpanStatusCode } from '@opentelemetry/api';
import { config } from '../../../config.js';
import { recordLlmUsage } from '../../../lib/otel-metrics.js';
import { otelTracer } from '../../../lib/otel.js';
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
    options?: {
      maxTokens?: number;
      temperature?: number;
      jsonMode?: boolean;
      workspaceId?: string;
    }
  ): Promise<{ content: string; usage: LlmCompletionUsage }> {
    const maxTokens = options?.maxTokens ?? this.resolved.maxOutputTokens;
    const temperature = options?.temperature ?? this.resolved.temperature;

    return otelTracer.startActiveSpan('llm.generate', async (span) => {
      span.setAttribute('llm.model', this.resolved.model);
      span.setAttribute('llm.provider', this.resolved.provider);
      if (options?.workspaceId) span.setAttribute('workspaceId', options.workspaceId);
      const t0 = Date.now();

      try {
        const result =
          this.resolved.provider === 'anthropic'
            ? await this.completeAnthropic(messages, maxTokens, temperature)
            : await this.completeOpenAiCompatible(
                messages,
                maxTokens,
                temperature,
                options?.jsonMode
              );

        span.setAttribute('promptTokens', result.usage.promptTokens);
        span.setAttribute('completionTokens', result.usage.completionTokens);
        recordLlmUsage({
          model: this.resolved.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          durationMs: Date.now() - t0,
          workspaceId: options?.workspaceId,
        });
        return result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * OpenAI Structured Outputs (`json_schema` + strict). Not supported on Anthropic.
   * Reuses the same client timeout as `complete` (`config.openai.timeoutMs`).
   */
  async completeJsonSchema(
    messages: LlmMessage[],
    jsonSchema: Record<string, unknown>,
    options?: {
      name?: string;
      maxTokens?: number;
      temperature?: number;
      workspaceId?: string;
    }
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

    return otelTracer.startActiveSpan('llm.generate', async (span) => {
      span.setAttribute('llm.model', this.resolved.model);
      span.setAttribute('llm.provider', this.resolved.provider);
      if (options?.workspaceId) span.setAttribute('workspaceId', options.workspaceId);
      const t0 = Date.now();

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
        const result = {
          content,
          usage: {
            promptTokens: usage?.prompt_tokens ?? 0,
            completionTokens: usage?.completion_tokens ?? 0,
            totalTokens: usage?.total_tokens ?? 0,
          },
        };
        span.setAttribute('promptTokens', result.usage.promptTokens);
        span.setAttribute('completionTokens', result.usage.completionTokens);
        recordLlmUsage({
          model: this.resolved.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          durationMs: Date.now() - t0,
          workspaceId: options?.workspaceId,
        });
        return result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw mapClientError(err);
      } finally {
        span.end();
      }
    });
  }

  /**
   * Token stream for voice/chat UIs. Yields `{ text }` chunks; return value is final usage.
   * Anthropic falls back to a single-shot complete (no native stream here yet).
   */
  async *streamComplete(
    messages: LlmMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
      model?: string;
      workspaceId?: string;
    }
  ): AsyncGenerator<{ text: string }, { content: string; usage: LlmCompletionUsage }, void> {
    const maxTokens = options?.maxTokens ?? this.resolved.maxOutputTokens;
    const temperature = options?.temperature ?? this.resolved.temperature;
    const model = options?.model || this.resolved.model;

    if (this.resolved.provider === 'anthropic') {
      const result = await this.complete(messages, { maxTokens, temperature, workspaceId: options?.workspaceId });
      if (result.content) yield { text: result.content };
      return result;
    }

    const baseURL = this.resolved.baseUrl?.replace(/\/$/, '') || undefined;
    const client = new OpenAI({
      apiKey: this.resolved.apiKey,
      baseURL: baseURL ? `${baseURL}/v1` : undefined,
      timeout: config.openai.timeoutMs,
    });

    const t0 = Date.now();
    try {
      const stream = await client.chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
      });

      let content = '';
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          content += delta;
          yield { text: delta };
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        }
      }

      recordLlmUsage({
        model,
        promptTokens,
        completionTokens,
        durationMs: Date.now() - t0,
        workspaceId: options?.workspaceId,
      });

      return {
        content: content.trim(),
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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
