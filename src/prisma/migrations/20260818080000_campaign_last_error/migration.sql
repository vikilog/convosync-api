-- Scheduled/worker campaign failures (e.g. template no longer approved by
-- the time the job runs) previously flipped status to 'failed' with no
-- stored reason anywhere — only the synchronous send path surfaced its
-- error, over HTTP, to the request that triggered it.
ALTER TABLE "Campaign" ADD COLUMN "lastError" TEXT;
