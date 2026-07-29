-- Expand SocialListeningPostSetting to full per-post agent settings.
-- Replace automationEnabled with autoResponseEnabled (default false / safe).

ALTER TABLE "SocialListeningPostSetting"
  ADD COLUMN IF NOT EXISTS "autoResponseEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Preserve prior opt-out flag where the old column still exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'SocialListeningPostSetting' AND column_name = 'automationEnabled'
  ) THEN
    EXECUTE 'UPDATE "SocialListeningPostSetting" SET "autoResponseEnabled" = "automationEnabled"';
    EXECUTE 'ALTER TABLE "SocialListeningPostSetting" DROP COLUMN "automationEnabled"';
  END IF;
END $$;

ALTER TABLE "SocialListeningPostSetting"
  ADD COLUMN IF NOT EXISTS "interestedMode" TEXT NOT NULL DEFAULT 'review',
  ADD COLUMN IF NOT EXISTS "questionMode" TEXT NOT NULL DEFAULT 'review',
  ADD COLUMN IF NOT EXISTS "complaintMode" TEXT NOT NULL DEFAULT 'review',
  ADD COLUMN IF NOT EXISTS "spamMode" TEXT NOT NULL DEFAULT 'review',
  ADD COLUMN IF NOT EXISTS "confidenceThreshold" INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS "publicReplyTone" TEXT NOT NULL DEFAULT 'friendly',
  ADD COLUMN IF NOT EXISTS "dmAgentSkillId" TEXT,
  ADD COLUMN IF NOT EXISTS "fallbackMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "leadCreationRule" TEXT NOT NULL DEFAULT 'interested_only',
  ADD COLUMN IF NOT EXISTS "maxAutoDmsPerDay" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "workingHoursOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "workingHoursStart" TEXT,
  ADD COLUMN IF NOT EXISTS "workingHoursEnd" TEXT;
