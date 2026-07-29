-- Per-post lead funnel target (overrides workspace Social Listening default).
ALTER TABLE "SocialListeningPostSetting"
  ADD COLUMN IF NOT EXISTS "leadFunnelId" TEXT;

CREATE INDEX IF NOT EXISTS "SocialListeningPostSetting_leadFunnelId_idx"
  ON "SocialListeningPostSetting"("leadFunnelId");

DO $$ BEGIN
  ALTER TABLE "SocialListeningPostSetting"
    ADD CONSTRAINT "SocialListeningPostSetting_leadFunnelId_fkey"
    FOREIGN KEY ("leadFunnelId") REFERENCES "LeadFunnel"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
