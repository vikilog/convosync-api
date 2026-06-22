/** Auto-sync intervals in milliseconds */
export const GBP_SYNC_INTERVALS = {
  accounts: 60 * 60 * 1000, // 1 hour
  locations: 60 * 60 * 1000, // 1 hour
  reviews: 10 * 60 * 1000, // 10 minutes
  metrics: 30 * 60 * 1000, // 30 minutes
  schedulerTick: 5 * 60 * 1000, // check every 5 minutes
} as const;
