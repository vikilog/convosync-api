-- Per-post Instagram Automation for comments (alongside Social Listening AI).
ALTER TABLE "SocialListeningPostSetting"
  ADD COLUMN IF NOT EXISTS "commentAutomationJourneyId" TEXT;

CREATE INDEX IF NOT EXISTS "SocialListeningPostSetting_commentAutomationJourneyId_idx"
  ON "SocialListeningPostSetting"("commentAutomationJourneyId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SocialListeningPostSetting_commentAutomationJourneyId_fkey'
  ) THEN
    ALTER TABLE "SocialListeningPostSetting"
      ADD CONSTRAINT "SocialListeningPostSetting_commentAutomationJourneyId_fkey"
      FOREIGN KEY ("commentAutomationJourneyId") REFERENCES "instagram_journeys"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
