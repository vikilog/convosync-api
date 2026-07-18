import { Queue } from 'bullmq';
import { config } from '../config.js';

export const CALL_TRANSCRIPT_QUEUE = 'call-transcript';

export type CallTranscriptJobData = {
  callId: string;
  workspaceId: string;
  language?: string;
};

let queue: Queue<CallTranscriptJobData> | null = null;

export function getCallTranscriptQueue(): Queue<CallTranscriptJobData> {
  if (!queue) {
    queue = new Queue<CallTranscriptJobData>(CALL_TRANSCRIPT_QUEUE, {
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
  }
  return queue;
}

export async function enqueueCallTranscript(data: CallTranscriptJobData): Promise<void> {
  if (!config.callStt.enabled) return;
  const q = getCallTranscriptQueue();
  // Drop prior completed/failed job with same id so retry works
  try {
    const existing = await q.getJob(`call-stt-${data.callId}`);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    }
  } catch {
    /* ignore */
  }
  await q.add('transcribe', data, {
    jobId: data.language
      ? `call-stt-${data.callId}-${data.language}`
      : `call-stt-${data.callId}`,
  });
}
