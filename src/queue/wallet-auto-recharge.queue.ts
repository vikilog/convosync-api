import { Queue } from 'bullmq';
import { config } from '../config.js';

export const WALLET_AUTO_RECHARGE_QUEUE = 'wallet-auto-recharge';

export type WalletAutoRechargeJobData = {
  workspaceId: string;
};

let queue: Queue<WalletAutoRechargeJobData> | null = null;

export function getWalletAutoRechargeQueue(): Queue<WalletAutoRechargeJobData> {
  if (!queue) {
    queue = new Queue<WalletAutoRechargeJobData>(WALLET_AUTO_RECHARGE_QUEUE, {
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return queue;
}
