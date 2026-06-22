/** Redis cache TTLs in seconds */
export const GBP_CACHE_TTL = {
  accounts: 60 * 60, // 1 hour
  locations: 60 * 60, // 1 hour
  reviews: 10 * 60, // 10 minutes
  metrics: 30 * 60, // 30 minutes
} as const;
