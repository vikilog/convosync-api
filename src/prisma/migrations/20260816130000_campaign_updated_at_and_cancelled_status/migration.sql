-- Campaign.updatedAt: touched periodically while a broadcast is sending, so
-- the stuck-campaign reaper can tell "genuinely crashed" apart from "still
-- actively sending a large audience" (both look identical as a bare status
-- read otherwise).
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "Campaign_status_updatedAt_idx" ON "Campaign" ("status", "updatedAt");
