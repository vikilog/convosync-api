import axios, { AxiosError } from 'axios';
import { config } from '../../../config.js';

export type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export class OpenAiProvider {
  private readonly baseUrl = 'https://api.openai.com/v1';

  isConfigured(): boolean {
    return Boolean(config.openai.apiKey);
  }

  async createTextChatCompletion(
    messages: OpenAiMessage[]
  ): Promise<{ content: string; tokensUsed: number; inputTokens: number; outputTokens: number }> {
    if (!config.openai.apiKey) {
      throw new OpenAiProviderError(
        'OpenAI is not configured. Set OPENAI_API_KEY in backend .env.',
        'OPENAI_NOT_CONFIGURED',
        503
      );
    }

    try {
      const res = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: config.openai.model,
          messages,
          temperature: config.openai.temperature,
          max_tokens: config.openai.maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: config.openai.timeoutMs,
        }
      );

      const content = res.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new OpenAiProviderError('Empty response from OpenAI', 'OPENAI_EMPTY_RESPONSE', 502);
      }
      const usage = res.data?.usage ?? {};
      return {
        content: content.trim(),
        tokensUsed: Number(usage.total_tokens ?? 0),
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
      };
    } catch (err) {
      if (err instanceof OpenAiProviderError) throw err;
      throw mapAxiosError(err);
    }
  }

  async createChatCompletion(
    messages: OpenAiMessage[]
  ): Promise<{
    content: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    if (!config.openai.apiKey) {
      throw new OpenAiProviderError(
        'OpenAI is not configured. Set OPENAI_API_KEY in backend .env.',
        'OPENAI_NOT_CONFIGURED',
        503
      );
    }

    try {
      const res = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model: config.openai.model,
          messages,
          temperature: config.openai.temperature,
          max_tokens: config.openai.maxTokens,
          response_format: { type: 'json_object' },
        },
        {
          headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: config.openai.timeoutMs,
        }
      );

      const content = res.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new OpenAiProviderError('Empty response from OpenAI', 'OPENAI_EMPTY_RESPONSE', 502);
      }
      const usage = res.data?.usage ?? {};
      return {
        content,
        usage: {
          promptTokens: Number(usage.prompt_tokens ?? 0),
          completionTokens: Number(usage.completion_tokens ?? 0),
          totalTokens: Number(usage.total_tokens ?? 0),
        },
      };
    } catch (err) {
      if (err instanceof OpenAiProviderError) throw err;
      throw mapAxiosError(err);
    }
  }
}

export class OpenAiProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'OpenAiProviderError';
  }
}

function mapAxiosError(err: unknown): OpenAiProviderError {
  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 502;
    const apiMessage =
      (err.response?.data as { error?: { message?: string } })?.error?.message ??
      err.message;
    return new OpenAiProviderError(
      `OpenAI request failed: ${apiMessage}`,
      'OPENAI_REQUEST_FAILED',
      status >= 400 && status < 600 ? status : 502
    );
  }
  const message = err instanceof Error ? err.message : 'Unknown OpenAI error';
  return new OpenAiProviderError(message, 'OPENAI_REQUEST_FAILED', 502);
}
