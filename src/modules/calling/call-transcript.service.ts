import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallSession, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getIo } from '../../socket.js';
import { config } from '../../config.js';
import { getObject } from '../../services/objectStorage.js';
import { CallingError } from './calling.types.js';

const callingDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(callingDir, '../../..');
const repoRoot = path.resolve(backendRoot, '..');
const DEFAULT_SCRIPT = path.join(repoRoot, 'stt', 'transcribe.py');

function resolveSttScript(): string {
  const override = config.callStt.scriptPath?.trim();
  if (!override) return DEFAULT_SCRIPT;
  return path.isAbsolute(override) ? override : path.resolve(backendRoot, override);
}

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type WhisperOut = {
  text?: string;
  language?: string | null;
  languageProbability?: number | null;
  duration?: number | null;
  segments?: TranscriptSegment[];
  error?: string;
  message?: string;
};

function emitTranscript(workspaceId: string, payload: Record<string, unknown>) {
  try {
    getIo().to(workspaceId).emit('call_transcript_ready', payload);
  } catch (err) {
    console.warn('[calling] transcript socket emit failed', err);
  }
}

async function enqueueInsightAfterTranscript(call: CallSession): Promise<void> {
  if (!call.contactId) return;
  const { enqueueContactInsight } = await import('../../queue/contact-insight.queue.js');
  void enqueueContactInsight({
    workspaceId: call.workspaceId,
    contactId: call.contactId,
    reason: 'call_transcript_ready',
  }).catch((err) => console.warn('[contact-insight] enqueue after STT failed', err));
}

/**
 * Persist a ready transcript (Faster-Whisper or Pipecat voice agent) + insight enqueue.
 */
export async function saveCallTranscriptFromExternal(input: {
  callSessionId: string;
  text: string;
  language?: string | null;
  segments?: TranscriptSegment[];
}): Promise<CallSession> {
  const text = input.text.trim();
  if (!text) {
    throw new CallingError('Empty transcript', 400, 'empty_transcript');
  }

  const call = await prisma.callSession.findUnique({ where: { id: input.callSessionId } });
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  const updated = await prisma.callSession.update({
    where: { id: call.id },
    data: {
      transcriptStatus: 'ready',
      transcriptText: text,
      transcriptJson: (input.segments ?? []) as unknown as Prisma.InputJsonValue,
      transcriptLanguage: input.language ?? null,
      transcriptError: null,
      transcriptAt: new Date(),
    },
  });

  emitTranscript(call.workspaceId, {
    callId: call.id,
    conversationId: call.conversationId,
    transcriptStatus: 'ready',
    transcriptLanguage: updated.transcriptLanguage,
    transcriptPreview: text.slice(0, 240),
  });

  await enqueueInsightAfterTranscript(updated);
  return updated;
}

/** Relay a live voice-agent turn to the workspace Socket.IO room. */
export async function emitLiveTranscriptChunk(input: {
  callSessionId: string;
  role: 'customer' | 'agent';
  text: string;
  at?: string;
}): Promise<void> {
  const text = input.text.trim();
  if (!text) return;

  const call = await prisma.callSession.findUnique({
    where: { id: input.callSessionId },
    select: { id: true, workspaceId: true, conversationId: true },
  });
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  try {
    const { CALL_SOCKET_EVENTS } = await import('./calling.types.js');
    getIo().to(call.workspaceId).emit(CALL_SOCKET_EVENTS.transcriptChunk, {
      callId: call.id,
      conversationId: call.conversationId,
      role: input.role,
      text,
      at: input.at || new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[calling] live transcript chunk emit failed', err);
  }
}

async function runFasterWhisperHttp(
  audioPath: string,
  opts?: { language?: string }
): Promise<WhisperOut> {
  const language = (opts?.language || config.callStt.language || 'auto').trim();
  const buf = await fs.readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)]), path.basename(audioPath) || 'audio.ogg');
  form.append('language', language);
  form.append('prefer_language', config.callStt.preferLanguage || 'hi');
  form.append('model', config.callStt.model);
  form.append('device', config.callStt.device);
  form.append('compute_type', config.callStt.computeType);
  if (config.callStt.initialPrompt) {
    form.append('initial_prompt', config.callStt.initialPrompt);
  }

  const res = await fetch(`${config.callStt.url}/transcribe`, {
    method: 'POST',
    body: form,
    // ponytail: Whisper medium on CPU can take many minutes; fail clean vs hang forever
    signal: AbortSignal.timeout(18 * 60 * 1000),
  });
  const text = await res.text();
  let parsed: WhisperOut | null = null;
  try {
    parsed = JSON.parse(text) as WhisperOut;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const detail =
      (parsed as { detail?: string } | null)?.detail ||
      parsed?.message ||
      parsed?.error ||
      text.slice(0, 300) ||
      `STT HTTP ${res.status}`;
    throw new Error(String(detail));
  }
  if (!parsed) throw new Error(`Invalid STT JSON: ${text.slice(0, 200)}`);
  return parsed;
}

async function runFasterWhisperCli(
  audioPath: string,
  opts?: { language?: string }
): Promise<WhisperOut> {
  const language = (opts?.language || config.callStt.language || 'auto').trim();
  const args = [
    resolveSttScript(),
    audioPath,
    '--model',
    config.callStt.model,
    '--language',
    language,
    '--prefer-language',
    config.callStt.preferLanguage || 'hi',
    '--device',
    config.callStt.device,
    '--compute-type',
    config.callStt.computeType,
  ];
  if (config.callStt.initialPrompt) {
    args.push('--initial-prompt', config.callStt.initialPrompt);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.callStt.pythonBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout) as WhisperOut);
        } catch {
          reject(new Error(`Invalid STT JSON: ${stdout.slice(0, 200)}`));
        }
        return;
      }
      let parsed: WhisperOut | null = null;
      try {
        parsed = JSON.parse(stderr.trim().split('\n').pop() || '') as WhisperOut;
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          parsed?.message ||
            parsed?.error ||
            stderr.trim() ||
            `STT exited with code ${code}`
        )
      );
    });
  });
}

async function runFasterWhisper(
  audioPath: string,
  opts?: { language?: string }
): Promise<WhisperOut> {
  if (config.callStt.url) {
    return runFasterWhisperHttp(audioPath, opts);
  }
  return runFasterWhisperCli(audioPath, opts);
}

/** Run Faster-Whisper on a call's ready recording and persist transcript. */
export async function transcribeCallRecording(
  callId: string,
  opts?: { language?: string }
): Promise<CallSession> {
  const call = await prisma.callSession.findUnique({ where: { id: callId } });
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  if (!config.callStt.enabled) {
    return prisma.callSession.update({
      where: { id: call.id },
      data: {
        transcriptStatus: 'skipped',
        transcriptError: 'call_stt_disabled',
      },
    });
  }

  if (call.recordingStatus !== 'ready' || !call.recordingStorageKey) {
    throw new CallingError('Recording not ready for transcription', 409, 'recording_not_ready');
  }

  if (call.transcriptStatus === 'ready' && call.transcriptText) {
    return call;
  }

  await prisma.callSession.update({
    where: { id: call.id },
    data: { transcriptStatus: 'processing', transcriptError: null },
  });

  const ext = path.extname(call.recordingStorageKey) || '.ogg';
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convosync-stt-'));
  const audioPath = path.join(tmpDir, `call${ext}`);

  try {
    const buf = await getObject(call.recordingStorageKey);
    await fs.writeFile(audioPath, buf);

    const result = await runFasterWhisper(audioPath, { language: opts?.language });
    const text = (result.text || '').trim();
    if (!text) {
      const updated = await prisma.callSession.update({
        where: { id: call.id },
        data: {
          transcriptStatus: 'failed',
          transcriptError: 'empty_transcript',
          transcriptAt: new Date(),
        },
      });
      emitTranscript(call.workspaceId, {
        callId: call.id,
        conversationId: call.conversationId,
        transcriptStatus: 'failed',
      });
      return updated;
    }

    const updated = await prisma.callSession.update({
      where: { id: call.id },
      data: {
        transcriptStatus: 'ready',
        transcriptText: text,
        transcriptJson: (result.segments ?? []) as unknown as Prisma.InputJsonValue,
        transcriptLanguage: result.language ?? null,
        transcriptError: null,
        transcriptAt: new Date(),
      },
    });

    emitTranscript(call.workspaceId, {
      callId: call.id,
      conversationId: call.conversationId,
      transcriptStatus: 'ready',
      transcriptLanguage: updated.transcriptLanguage,
      transcriptPreview: text.slice(0, 240),
    });

    await enqueueInsightAfterTranscript(updated);

    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'transcribe_failed';
    console.warn('[calling] STT failed', call.id, message);
    const updated = await prisma.callSession.update({
      where: { id: call.id },
      data: {
        transcriptStatus: 'failed',
        transcriptError: message.slice(0, 500),
        transcriptAt: new Date(),
      },
    });
    emitTranscript(call.workspaceId, {
      callId: call.id,
      conversationId: call.conversationId,
      transcriptStatus: 'failed',
      error: message.slice(0, 200),
    });
    return updated;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function getCallTranscript(input: {
  workspaceId: string;
  callId: string;
}): Promise<{
  callId: string;
  status: string | null;
  text: string | null;
  language: string | null;
  segments: TranscriptSegment[];
  error: string | null;
  at: string | null;
}> {
  const call = await prisma.callSession.findFirst({
    where: { id: input.callId, workspaceId: input.workspaceId },
  });
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  const segments = Array.isArray(call.transcriptJson)
    ? (call.transcriptJson as TranscriptSegment[])
    : [];

  return {
    callId: call.id,
    status: call.transcriptStatus,
    text: call.transcriptText,
    language: call.transcriptLanguage,
    segments,
    error: call.transcriptError,
    at: call.transcriptAt?.toISOString() ?? null,
  };
}
