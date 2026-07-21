import { Worker } from 'bullmq';
import { config } from '../config.js';
import { withJobSpan } from '../lib/otel-job.js';
import { recordCampaignBroadcastDuration } from '../lib/otel-metrics.js';
import { executeCampaignBroadcast } from '../services/campaignBroadcast.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startCampaignWorker() {
  const worker = new Worker(
    'campaign-broadcast',
    async (job) => {
      const { campaignId, workspaceId } = job.data as { campaignId: string; workspaceId: string };
      const t0 = Date.now();
      await withJobSpan(
        'queue.campaign-broadcast',
        { campaignId, workspaceId, jobId: String(job.id ?? '') },
        () => executeCampaignBroadcast(campaignId, workspaceId)
      );
      recordCampaignBroadcastDuration(Date.now() - t0, workspaceId);
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('Campaign worker failed', job?.id, err);
  });

  return worker;
}
