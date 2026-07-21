/**
 * Agent Call UI preview STT/TTS — proxies to voice-agent-service using the
 * agent's selected providers (Cartesia / Deepgram / OpenAI), same as live calls.
 */
import { config } from '../config.js';

export class PreviewSttError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'PreviewSttError';
  }
}

function voiceAgentBase(): string {
  const url = config.voiceAgent.serviceUrl?.trim();
  if (!url) {
    throw new PreviewSttError('VOICE_AGENT_SERVICE_URL is not configured', 503, 'voice_agent_missing');
  }
  return url.replace(/\/$/, '');
}

function internalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.voiceAgent.internalSecret) {
    headers['X-ConvoSync-Internal'] = config.voiceAgent.internalSecret;
  }
  return headers;
}

async function readErrorDetail(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { detail?: string; message?: string };
    if (typeof json.detail === 'string') return json.detail;
    if (typeof json.message === 'string') return json.message;
  } catch {
    /* ignore */
  }
  return text.slice(0, 200) || `HTTP ${res.status}`;
}

/** Sync STT for agent voice preview (MediaRecorder blob → selected provider). */
export async function transcribePreviewAudio(input: {
  buffer: Buffer;
  mimeType?: string;
  fileName?: string;
  language?: string;
  sttProvider?: string;
}): Promise<{ text: string; language: string | null; sttMs: number; provider: string }> {
  if (!input.buffer.length) {
    throw new PreviewSttError('Empty audio', 400, 'empty_audio');
  }

  const provider = (input.sttProvider || 'cartesia').trim().toLowerCase() || 'cartesia';
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(input.buffer)], { type: input.mimeType || 'audio/webm' }),
    input.fileName || 'preview.webm'
  );
  form.append('sttProvider', provider);
  if (input.language) form.append('language', input.language);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${voiceAgentBase()}/preview/stt`, {
      method: 'POST',
      headers: internalHeaders(),
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new PreviewSttError(
      err instanceof Error ? err.message : 'Voice agent unreachable',
      503,
      'voice_agent_unreachable'
    );
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new PreviewSttError(detail, res.status === 422 ? 422 : 502, 'stt_failed');
  }

  const parsed = (await res.json()) as {
    text?: string;
    language?: string | null;
    sttMs?: number;
    provider?: string;
  };
  const text = (parsed.text || '').trim();
  if (!text) {
    throw new PreviewSttError('Could not understand audio — try again', 422, 'empty_transcript');
  }

  return {
    text,
    language: parsed.language ?? null,
    sttMs: parsed.sttMs ?? Date.now() - started,
    provider: parsed.provider || provider,
  };
}

/** TTS for agent voice preview (text → selected provider audio). */
export async function synthesizePreviewSpeech(input: {
  text: string;
  ttsProvider?: string;
  ttsVoiceId?: string | null;
}): Promise<{ buffer: Buffer; mimeType: string; ttsMs: number; provider: string }> {
  const text = (input.text || '').trim();
  if (!text) {
    throw new PreviewSttError('Empty text', 400, 'empty_text');
  }

  const provider = (input.ttsProvider || 'cartesia').trim().toLowerCase() || 'cartesia';
  let res: Response;
  try {
    res = await fetch(`${voiceAgentBase()}/preview/tts`, {
      method: 'POST',
      headers: {
        ...internalHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        ttsProvider: provider,
        ttsVoiceId: input.ttsVoiceId || null,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new PreviewSttError(
      err instanceof Error ? err.message : 'Voice agent unreachable',
      503,
      'voice_agent_unreachable'
    );
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new PreviewSttError(detail, 502, 'tts_failed');
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) {
    throw new PreviewSttError('Empty TTS audio', 502, 'empty_tts');
  }

  const ttsMsHeader = res.headers.get('X-TTS-Ms');
  return {
    buffer: buf,
    mimeType: res.headers.get('content-type') || 'audio/mpeg',
    ttsMs: ttsMsHeader ? parseInt(ttsMsHeader, 10) || 0 : 0,
    provider: res.headers.get('X-TTS-Provider') || provider,
  };
}
