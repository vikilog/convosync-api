import { Worker } from 'bullmq';
import { config } from '../config.js';
import {
  CALL_TRANSCRIPT_QUEUE,
  type CallTranscriptJobData,
} from '../queue/call-transcript.queue.js';
import { transcribeCallRecording } from '../modules/calling/call-transcript.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

/** Faster-Whisper is CPU/GPU heavy — keep concurrency at 1. */
export function startCallTranscriptWorker() {
  if (!config.callStt.enabled) {
    console.log('[calling] STT worker skipped (CALL_STT_ENABLED=false)');
    return null;
  }

  const worker = new Worker<CallTranscriptJobData>(
    CALL_TRANSCRIPT_QUEUE,
    async (job) => {
      await transcribeCallRecording(job.data.callId, {
        language: job.data.language,
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    console.error('[calling] STT worker failed', job?.id, err);
  });

  worker.on('completed', (job) => {
    console.log('[calling] STT completed', job.data.callId);
  });

  return worker;
}
