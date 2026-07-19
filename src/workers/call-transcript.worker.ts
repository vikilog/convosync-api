import { Worker } from 'bullmq';
import { config } from '../config.js';
import {
  CALL_TRANSCRIPT_QUEUE,
  type CallTranscriptJobData,
} from '../queue/call-transcript.queue.js';
import { transcribeCallRecording } from '../modules/calling/call-transcript.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

/**
 * Faster-Whisper on CPU often runs 2–10+ min. BullMQ default lockDuration is 30s —
 * if the API process restarts (tsx watch) or lock renewals lag, the job is marked
 * stalled and fails with "job stalled more than allowable limit".
 */
const STT_LOCK_MS = 20 * 60 * 1000; // 20 min

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
    {
      connection,
      concurrency: 1,
      lockDuration: STT_LOCK_MS,
      stalledInterval: 60_000,
      maxStalledCount: 3,
    }
  );

  worker.on('failed', (job, err) => {
    console.error('[calling] STT worker failed', job?.id, err);
  });

  worker.on('completed', (job) => {
    console.log('[calling] STT completed', job.data.callId);
  });

  worker.on('stalled', (jobId) => {
    console.warn('[calling] STT job stalled (will retry if under maxStalledCount)', jobId);
  });

  return worker;
}
