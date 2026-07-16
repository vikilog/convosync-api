import { Worker } from 'bullmq';
import { config } from '../config.js';
import { WALLET_AUTO_RECHARGE_QUEUE } from '../queue/wallet-auto-recharge.queue.js';
import type { WalletAutoRechargeJobData } from '../queue/wallet-auto-recharge.queue.js';
import {
  processWalletAutoRecharge,
  scanLowBalanceAutoRechargeWallets,
} from '../services/walletAutoRecharge.service.js';

const connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };

export function startWalletAutoRechargeWorker() {
  const worker = new Worker<WalletAutoRechargeJobData>(
    WALLET_AUTO_RECHARGE_QUEUE,
    async (job) => {
      await processWalletAutoRecharge(job.data.workspaceId);
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error('[WalletAutoRecharge] job failed', job?.id, err);
  });

  const scanIntervalMs = 15 * 60 * 1000;
  setInterval(() => {
    void scanLowBalanceAutoRechargeWallets().catch((err) => {
      console.error('[WalletAutoRecharge] scan failed', err);
    });
  }, scanIntervalMs);

  return worker;
}
