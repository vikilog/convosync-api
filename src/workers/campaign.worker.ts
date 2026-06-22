import { Worker } from 'bullmq';
import { config } from '../config.js';
import { executeCampaignBroadcast } from '../services/campaignBroadcast.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startCampaignWorker() {
  const worker = new Worker(
    'campaign-broadcast',
    async (job) => {
      const { campaignId, workspaceId } = job.data as { campaignId: string; workspaceId: string };
      await executeCampaignBroadcast(campaignId, workspaceId);
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('Campaign worker failed', job?.id, err);
  });

  return worker;
}
